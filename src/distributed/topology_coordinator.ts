import * as async from "async";
import * as leader from "./topology_leader";
import * as intf from "../topology_interfaces";
import * as log from "../util/logger";

/** Interface for objects that coordinator needs to communicate with. */
export interface TopologyCoordinatorClient {
    /** Obejct needs to start given topology */
    startTopology(uuid: string, config: any, callback: intf.SimpleCallback);
    /** Object needs to stop given topology */
    stopTopology(uuid: string, callback: intf.SimpleCallback);
    /** Object needs to kill given topology */
    killTopology(uuid: string, callback: intf.SimpleCallback);
    /** Object should resolve differences between running topologies and the given list. */
    resolveTopologyMismatches(uuids: string[], callback: intf.SimpleCallback);
    /** Object should shut down */
    shutdown(callback: intf.SimpleCallback);
    /** Process exit wrapper */
    exit(code: number);
}

/** This class handles communication with topology coordination storage.
 */
export class TopologyCoordinator {

    private storage: intf.CoordinationStorage;
    private client: TopologyCoordinatorClient;
    private name: string;
    private is_shutting_down: boolean;
    private is_running: boolean;
    private shutdown_callback: intf.SimpleCallback;
    private loop_timeout: number;
    private leadership: leader.TopologyLeader;
    private start_time: Date;
    private log_prefix: string;
    private pingIntervalId: NodeJS.Timer;
    private pingInterval: number;

    /** Simple constructor */
    constructor(name: string, storage: intf.CoordinationStorage, client: TopologyCoordinatorClient) {
        this.storage = storage;
        this.client = client;
        this.name = name;
        this.leadership = new leader.TopologyLeader(this.name, this.storage, null);
        this.is_running = false;
        this.is_shutting_down = false;
        this.shutdown_callback = null;
        this.loop_timeout = 2 * 1000; // 2 seconds for refresh
        this.start_time = new Date();
        this.log_prefix = "[Coordinator] ";
        this.pingIntervalId = null;
        this.pingInterval = 1000;
    }

    /** Runs main loop */
    run() {
        let self = this;
        self.is_running = true;
        self.storage.registerWorker(self.name, () => {
            self.setPingInterval();
        });
        self.leadership.run();

        let check_counter = 0;
        async.whilst(
            () => {
                return self.is_running;
            },
            (xcallback) => {
                async.parallel(
                    [
                        (ycallback) => {
                            if (self.leadership.isRunning()) {
                                ycallback();
                            } else {
                                self.is_running = false;
                                ycallback(new Error("Leadership object was stopped"));
                            }
                        },
                        (ycallback) => {
                            setTimeout(() => {
                                self.handleIncommingRequests(ycallback);
                            }, self.loop_timeout);
                        },
                        (ycallback) => {
                            if (++check_counter % 5 == 1) {
                                self.checkAssignedTopologies(ycallback);
                            } else {
                                ycallback();
                            }
                        },
                        (ycallback) => {
                            if (++check_counter % 5 == 0) {
                                self.checkWorkerStatus(ycallback);
                            } else {
                                ycallback();
                            }
                        }
                    ],
                    xcallback
                );
            },
            (err: Error) => {
                log.logger().important(self.log_prefix + "Coordinator stopped.");
                if (self.shutdown_callback) {
                    self.shutdown_callback(err);
                } else {
                    // This exit was not triggered from outside,
                    // so notify the parent.
                    self.client.shutdown(() => {
                        log.logger().important(this.log_prefix + "Exiting with code 0");
                        self.client.exit(0);
                    });
                }
            }
        );
    }

    /** Shut down the loop */
    preShutdown(callback: intf.SimpleCallback) {
        let self = this;
        self.is_shutting_down = true;
        self.reportWorker(self.name, intf.Consts.WorkerStatus.closing, "", (err: Error) => {
            if (err) {
                log.logger().error(self.log_prefix + "Error while reporting worker status as 'closing':");
                log.logger().exception(err);
            }
            self.leadership.shutdown((err: Error) => {
                if (err) {
                    log.logger().error(self.log_prefix + "Error while shutting down leader:");
                    log.logger().exception(err);
                }
                callback();
            });
        });
    }


    /** Shut down the loop */
    shutdown(callback: intf.SimpleCallback) {
        let self = this;
        log.logger().important(self.log_prefix + "Shutting down coordinator");
        // TODO check what happens when a topology is waiting
        self.reportWorker(self.name, intf.Consts.WorkerStatus.dead, "", (err) => {
            clearInterval(self.pingIntervalId);
            if (err) {
                log.logger().error(self.log_prefix + "Error while reporting worker status as 'dead':");
                log.logger().exception(err);
            }
            if (self.is_running) {
                self.shutdown_callback = callback;
                self.is_running = false;
            } else {
                callback();
            }
        });
    }

    /** Set status on given topology */
    reportTopology(uuid: string, status: string, error: string, callback?: intf.SimpleCallback) {
        let self = this;
        this.storage.setTopologyStatus(uuid, this.name, status, error, (err) => {
            if (err) {
                log.logger().error(self.log_prefix + "Couldn't report topology status");
                log.logger().error(self.log_prefix + `Topology: ${uuid}, status=${status}, error=${error}`);
                log.logger().exception(err);
            }
            if (callback) {
                callback(err);
            }
        });
    }
    /** Set pid on given topology */
    reportTopologyPid(uuid: string, pid: number, callback?: intf.SimpleCallback) {
        let self = this;
        this.storage.setTopologyPid(uuid, pid, (err) => {
            if (err) {
                log.logger().error(self.log_prefix + "Couldn't report topology pid");
                log.logger().error(self.log_prefix + `Topology: ${uuid}, pid=${pid}`);
                log.logger().exception(err);
            }
            if (callback) {
                callback(err);
            }
        });
    }

    /** Set status on given worker */
    reportWorker(name: string, status: string, error: string, callback?: intf.SimpleCallback) {
        let self = this;
        this.storage.setWorkerStatus(name, status, (err) => {
            if (err) {
                log.logger().error(self.log_prefix + "Couldn't report worker status");
                log.logger().error(self.log_prefix + `Worker: name=${name}, status=${status}`);
                log.logger().exception(err);
            }
            if (callback) {
                callback(err);
            }
        });
    }

    /** This method checks for new messages from coordination storage. */
    private handleIncommingRequests(callback: intf.SimpleCallback) {
        let self = this;
        if (self.is_shutting_down) {
            return callback();
        }
        self.storage.getMessage(self.name, (err, msg) => {
            if (err) { return callback(err); }
            if (!msg) { return callback(); }
            if (msg.created < self.start_time) {
                // just ignore, it was sent before this coordinator was started
                return callback();
            } else if (msg.cmd === intf.Consts.LeaderMessages.start_topology) {
                self.storage.getTopologyInfo(msg.content.uuid, (err, res) => {
                    if (err) { return callback(err); }
                    if (self.name == res.worker && res.status == intf.Consts.TopologyStatus.waiting) {
                        // topology is still assigned to this worker
                        // otherwise the message could be old and stale, the toplogy was re-assigned to another worker
                        self.client.startTopology(msg.content.uuid, res.config, callback);
                    } else {
                        return callback();
                    }
                });
            } else if (msg.cmd === intf.Consts.LeaderMessages.start_topologies) {
                async.each(msg.content.uuids, (uuid: string, xcallback) => {
                    self.storage.getTopologyInfo(uuid, (err, res) => {
                        if (err) { return xcallback(err); }
                        if (self.name == res.worker && res.status == intf.Consts.TopologyStatus.waiting) {
                            // topology is still assigned to this worker
                            // otherwise the message could be old and stale, the toplogy was re-assigned to another worker
                            self.client.startTopology(uuid, res.config, xcallback);
                        } else {
                            return xcallback();
                        }
                    });
                }, (err: Error) => {
                    return callback(err);
                });
            } else if (msg.cmd === intf.Consts.LeaderMessages.stop_topology) {
                self.client.stopTopology(msg.content.uuid, callback);
                //// TODO: remove (2017-12-11)
                // self.client.stopTopology(msg.content.uuid, () => {
                //     // errors will be reported to storage and prevent starting new topologies
                //     if (msg.content.worker_new) {
                //         // ok, we got an instruction to explicitly re-assign topology to new worker
                //         self.leadership.assignTopologyToWorker(msg.content.worker_new, msg.content.uuid, callback);
                //     } else {
                //         return callback();
                //     }
                // });
            } else if (msg.cmd === intf.Consts.LeaderMessages.stop_topologies) {
                async.each(msg.content.stop_topologies,
                    (stop_topology: any, xcallback) => {
                        self.client.stopTopology(stop_topology.uuid, xcallback);
                        //// TODO: remove (2017-12-11)
                        // self.client.stopTopology(stop_topology.uuid, () => {
                        //     // errors will be reported to storage and prevent starting new topologies
                        //     if (stop_topology.worker_new) {
                        //         // ok, we got an instruction to explicitly re-assign topology to new worker
                        //         self.leadership.assignTopologyToWorker(stop_topology.worker_new, stop_topology.uuid, xcallback);
                        //     } else {
                        //         return xcallback();
                        //     }
                        // });
                    }, callback);
            } else if (msg.cmd === intf.Consts.LeaderMessages.kill_topology) {
                self.client.killTopology(msg.content.uuid, callback);
            } else if (msg.cmd === intf.Consts.LeaderMessages.shutdown) {
                // shutdown only logs exceptions
                self.client.shutdown(() => {
                    log.logger().important(this.log_prefix + "Exiting with code 0");
                    self.client.exit(0);
                });
                return callback();
            } else if (msg.cmd === intf.Consts.LeaderMessages.rebalance) {
                self.leadership.forceRebalance();
                return callback();
            } else {
                // unknown message
                return callback();
            }
        });
    }

    /** This method checks current status for this worker.
     * It might happen that leader marked it as dead (e.g. pings were not 
     * comming into db for some time), but this worker is actually still alive.
     * The worker must announce that it is available. The leader will then 
     * handle the topologies appropriatelly.
     */
    private checkWorkerStatus(callback: intf.SimpleCallback) {
        let self = this;
        self.storage.getWorkerStatus((err, workers) => {
            if (err) return callback(err);
            let curr_status = workers
                .filter(x => x.name == self.name)
                .map(x => x.status);
            if (curr_status.length == 0) {
                // current worker doesn't have a record
                self.storage.registerWorker(self.name, callback);
            } else if (curr_status[0] != intf.Consts.WorkerStatus.alive) {
                // state was set to something else, but this worker is still running
                self.storage.setWorkerStatus(self.name, intf.Consts.WorkerStatus.alive, callback);
            } else {
                callback();
            }
        });
    }

    /** This method checks if all topologies, assigned to this worker, actually run. */
    // TODO assert PIDs
    private checkAssignedTopologies(callback: intf.SimpleCallback) {
        let self = this;
        self.storage.getTopologiesForWorker(self.name, (err, topologies) => {
            if (err) return callback(err);
            let topologies_running = topologies
                .filter(x => x.status == intf.Consts.TopologyStatus.running)
                .map(x => x.uuid);

            self.client.resolveTopologyMismatches(topologies_running, callback);
        });
    }

    private setPingInterval() {
        let self = this;
        if (self.pingIntervalId) {
            clearInterval(self.pingIntervalId);
        }
        // send ping to child in regular intervals
        self.pingIntervalId = setInterval(
            () => {
                self.storage.pingWorker(self.name, (err) => {
                    if (err) {
                        log.logger().error(self.log_prefix + "Error while sending worker ping:");
                        log.logger().exception(err);
                    }
                })
            },
            self.pingInterval);
    }
}
