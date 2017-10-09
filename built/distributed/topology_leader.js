"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const async = require("async");
const lb = require("../util/load_balance");
const intf = require("../topology_interfaces");
const log = require("../util/logger");
const AFFINITY_FACTOR = 5;
const REBALANCE_INTERVAL = 60 * 60 * 1000;
const DEFAULT_LEADER_LOOP_INTERVAL = 5 * 1000;
const MESSAGE_INTERVAL = 20 * 1000;
const WORKER_IDLE_INTERVAL = 30 * 1000;
const LEADER_IDLE_INTERVAL = 3 * DEFAULT_LEADER_LOOP_INTERVAL;
/** This class handles leader-status determination and
 * performs leadership tasks if marked as leader.
 */
class TopologyLeader {
    /** Simple constructor */
    constructor(name, storage, loop_timeout) {
        this.storage = storage;
        this.name = name;
        this.is_running = false;
        this.shutdown_callback = null;
        this.is_leader = false;
        this.is_shut_down = false;
        this.loop_timeout = loop_timeout || DEFAULT_LEADER_LOOP_INTERVAL;
        this.next_rebalance = Date.now() + REBALANCE_INTERVAL;
        this.log_prefix = "[Leader] ";
    }
    /** Runs main loop that handles leadership detection */
    run() {
        let self = this;
        self.is_shut_down = false;
        self.is_running = true;
        async.whilst(() => {
            return self.is_running;
        }, (xcallback) => {
            setTimeout(() => {
                self.singleLoopStep(xcallback);
            }, self.loop_timeout);
        }, (err) => {
            log.logger().important(self.log_prefix + "Leader shutdown finished.");
            self.is_shut_down = true;
            self.is_running = false;
            if (self.shutdown_callback) {
                self.shutdown_callback(err);
            }
        });
    }
    /** Single step for loop - can be called form outside, for testing. */
    singleLoopStep(callback) {
        let self = this;
        if (self.is_leader) {
            self.performLeaderLoop(callback);
        }
        else {
            self.checkIfLeaderDetermined(callback);
        }
    }
    /** Shut down the loop */
    shutdown(callback) {
        let self = this;
        if (self.is_shut_down) {
            callback();
        }
        else {
            self.shutdown_callback = callback;
            self.is_running = false;
        }
    }
    /** Forces this leader to perform a rebalance the next time it runs its loop. */
    forceRebalance() {
        this.next_rebalance = 0;
    }
    /** Sometimes outside code gets instruction to assign topology to specific worker. */
    assignTopologyToWorker(target, uuid, callback) {
        let self = this;
        log.logger().log(self.log_prefix + `Assigning topology ${uuid} to worker ${target}`);
        self.storage.assignTopology(uuid, target, (err) => {
            self.storage.sendMessageToWorker(target, intf.Consts.LeaderMessages.start_topology, { uuid: uuid }, MESSAGE_INTERVAL, callback);
        });
    }
    /** Single step in checking if current node should be
     * promoted into leadership role.
     **/
    checkIfLeaderDetermined(callback) {
        let self = this;
        let should_announce = true;
        async.series([
            (xcallback) => {
                self.refreshStatuses((err, data) => {
                    if (err)
                        return xcallback(err);
                    should_announce = (data.leadership_status != intf.Consts.LeadershipStatus.ok);
                    xcallback();
                });
            },
            (xcallback) => {
                if (!should_announce)
                    return xcallback();
                self.storage.announceLeaderCandidacy(self.name, xcallback);
            },
            (xcallback) => {
                if (!should_announce)
                    return xcallback();
                self.storage.checkLeaderCandidacy(self.name, (err, is_leader) => {
                    if (err)
                        return xcallback(err);
                    self.is_leader = is_leader;
                    if (self.is_leader) {
                        log.logger().important(self.log_prefix + "This worker became a leader...");
                        self.performLeaderLoop(xcallback);
                    }
                    else {
                        xcallback();
                    }
                });
            }
        ], callback);
    }
    /** Single step in performing leadership role.
     * Checks work statuses and redistributes topologies for dead
     * to alive workers.
     */
    performLeaderLoop(callback) {
        let self = this;
        let perform_loop = true;
        let alive_workers = null;
        let worker_weights = new Map();
        let topologies_for_rebalance = [];
        async.series([
            (xcallback) => {
                self.storage.getWorkerStatus((err, workers) => {
                    if (err)
                        return xcallback(err);
                    let this_worker_lstatus = workers
                        .filter(x => x.name === self.name)
                        .map(x => x.lstatus)[0];
                    if (this_worker_lstatus != intf.Consts.WorkerLStatus.leader) {
                        // this worker is not marked as leader, abort leadership
                        perform_loop = false;
                        self.is_leader = false;
                        return xcallback();
                    }
                    let dead_workers = workers
                        .filter(x => x.status === intf.Consts.WorkerStatus.dead)
                        .map(x => x.name);
                    alive_workers = workers
                        .filter(x => x.status === intf.Consts.WorkerStatus.alive);
                    if (alive_workers.length == 0) {
                        return xcallback();
                    }
                    async.each(dead_workers, (dead_worker, ycallback) => {
                        self.handleDeadWorker(dead_worker, ycallback);
                    }, xcallback);
                });
            },
            (xcallback) => {
                if (!perform_loop || alive_workers.length == 0) {
                    return xcallback();
                }
                self.storage.getTopologyStatus((err, topologies) => {
                    if (err)
                        return xcallback(err);
                    topologies = topologies.filter(x => x.enabled);
                    topologies.forEach(x => {
                        x.weight = x.weight || 1;
                        x.worker_affinity = x.worker_affinity || [];
                        if (x.status == "" || x.status == intf.Consts.TopologyStatus.unassigned) {
                            for (let worker of alive_workers) {
                                let name = worker.name;
                                if (name == x.worker) {
                                    let old_weight = 0;
                                    if (worker_weights.has(name)) {
                                        old_weight = worker_weights.get(name);
                                    }
                                    worker_weights.set(name, old_weight + x.weight);
                                    break;
                                }
                            }
                        }
                        topologies_for_rebalance.push({
                            uuid: x.uuid,
                            weight: x.weight,
                            worker: x.worker,
                            affinity: x.worker_affinity
                        });
                    });
                    let unassigned_topologies = topologies
                        .filter(x => x.status === intf.Consts.TopologyStatus.unassigned);
                    if (unassigned_topologies.length > 0) {
                        log.logger().log(self.log_prefix + "Found unassigned topologies: " + JSON.stringify(unassigned_topologies));
                    }
                    let load_balancer = new lb.LoadBalancerEx(alive_workers.map(x => {
                        return { name: x.name, weight: worker_weights.get(x.name) || 0 };
                    }), AFFINITY_FACTOR // affinity means N-times stronger gravitational pull towards that worker
                    );
                    async.eachSeries(unassigned_topologies, (item, ycallback) => {
                        let ut = item;
                        self.assignUnassignedTopology(ut, load_balancer, ycallback);
                    }, xcallback);
                });
            },
            (xcallback) => {
                if (self.is_leader) {
                    self.performRebalanceIfNeeded(alive_workers, topologies_for_rebalance, xcallback);
                }
                else {
                    xcallback();
                }
            }
        ], callback);
    }
    /** This method will perform rebalance of topologies on workers if needed.
     */
    performRebalanceIfNeeded(workers, topologies, callback) {
        let self = this;
        if (self.next_rebalance > Date.now()) {
            return callback();
        }
        self.next_rebalance = Date.now() + REBALANCE_INTERVAL;
        if (!workers || workers.length == 0) {
            return callback();
        }
        if (!topologies || topologies.length == 0) {
            return callback();
        }
        let load_balancer = new lb.LoadBalancerEx(workers.map(x => {
            return { name: x.name, weight: 0 };
        }), AFFINITY_FACTOR);
        let steps = load_balancer.rebalance(topologies);
        async.each(steps.changes, (change, xcallback) => {
            log.logger().log(self.log_prefix + `Rebalancing - assigning topology ${change.uuid} from worker ${change.worker_old} to worker ${change.worker_new}`);
            self.storage.sendMessageToWorker(change.worker_old, intf.Consts.LeaderMessages.stop_topology, { uuid: change.uuid, new_worker: change.worker_new }, MESSAGE_INTERVAL, xcallback);
        }, callback);
    }
    /**
     * This method assigns topology to the worker that is provided by the load-balancer.
     * @param ut - unassigned toplogy object
     * @param load_balancer - load balancer object that tells you which worker to send the topology to
     * @param callback - callback to call when done
     */
    assignUnassignedTopology(ut, load_balancer, callback) {
        let self = this;
        let target = load_balancer.next(ut.worker_affinity, ut.weight);
        self.assignTopologyToWorker(target, ut.uuid, callback);
    }
    /** Handles situation when there is a dead worker and its
     * topologies need to be re-assigned to other servers.
     */
    handleDeadWorker(dead_worker, callback) {
        let self = this;
        log.logger().important(self.log_prefix + "Handling dead worker " + dead_worker);
        self.storage.getTopologiesForWorker(dead_worker, (err, topologies) => {
            async.each(topologies, (topology, xcallback) => {
                log.logger().important(self.log_prefix + "Unassigning topology " + topology.uuid);
                if (topology.status == intf.Consts.TopologyStatus.error) {
                    // this status must stay as it is
                    xcallback();
                }
                else {
                    self.storage.setTopologyStatus(topology.uuid, intf.Consts.TopologyStatus.unassigned, null, xcallback);
                }
            }, (err) => {
                if (err) {
                    log.logger().important(self.log_prefix + "Error while handling dead worker " + err);
                    return callback(err);
                }
                log.logger().important(self.log_prefix + "Setting dead worker as unloaded: " + dead_worker);
                self.storage.setWorkerStatus(dead_worker, intf.Consts.WorkerStatus.unloaded, callback);
            });
        });
    }
    /** Checks single worker record and de-activates it if needed. */
    disableDefunctWorkerSingle(worker, callback) {
        let self = this;
        let limit1 = Date.now() - WORKER_IDLE_INTERVAL;
        let limit2 = Date.now() - LEADER_IDLE_INTERVAL;
        async.series([
            (xcallback) => {
                // handle status
                if (worker.status != intf.Consts.WorkerStatus.alive)
                    return xcallback();
                if (worker.last_ping >= limit1)
                    return xcallback();
                worker.status = intf.Consts.WorkerStatus.dead;
                self.storage.setWorkerStatus(worker.name, worker.status, xcallback);
            },
            (xcallback) => {
                // handle lstatus
                if (worker.lstatus != intf.Consts.WorkerLStatus.normal && worker.status != intf.Consts.WorkerStatus.alive) {
                    worker.lstatus = intf.Consts.WorkerLStatus.normal;
                    self.storage.setWorkerLStatus(worker.name, worker.lstatus, xcallback);
                }
                else if (worker.lstatus != intf.Consts.WorkerLStatus.normal && worker.last_ping < limit2) {
                    worker.lstatus = intf.Consts.WorkerLStatus.normal;
                    self.storage.setWorkerLStatus(worker.name, worker.lstatus, xcallback);
                }
                else {
                    xcallback();
                }
            }
        ], callback);
    }
    /** checks all worker records if any of them is not active anymore. */
    disableDefunctWorkers(data_workers, callback) {
        let self = this;
        let limit = Date.now() - WORKER_IDLE_INTERVAL;
        async.each(data_workers, (worker, xcallback) => {
            self.disableDefunctWorkerSingle(worker, xcallback);
        }, callback);
    }
    /** Detaches toplogies from inactive workers */
    unassignWaitingTopologies(data_workers, callback) {
        let self = this;
        let dead_workers = data_workers
            .filter(x => x.status == intf.Consts.WorkerStatus.dead || x.status == intf.Consts.WorkerStatus.unloaded)
            .map(x => x.name);
        self.storage.getTopologyStatus((err, data) => {
            if (err)
                return callback(err);
            let limit = Date.now() - WORKER_IDLE_INTERVAL;
            async.each(data, (topology, xcallback) => {
                if (topology.status == intf.Consts.TopologyStatus.waiting && topology.last_ping < limit) {
                    self.storage.setTopologyStatus(topology.uuid, intf.Consts.TopologyStatus.unassigned, null, xcallback);
                }
                else if (topology.status == intf.Consts.TopologyStatus.running && dead_workers.indexOf(topology.worker) >= 0) {
                    self.storage.setTopologyStatus(topology.uuid, intf.Consts.TopologyStatus.unassigned, null, xcallback);
                }
                else {
                    xcallback();
                }
            }, callback);
        });
    }
    /** Gets and refreshes worker statuses */
    refreshStatuses(callback) {
        let self = this;
        let workers = null;
        let res = {
            leadership_status: intf.Consts.LeadershipStatus.vacant
        };
        async.series([
            (xcallback) => {
                self.storage.getWorkerStatus((err, data) => {
                    if (err)
                        return xcallback(err);
                    workers = data;
                    xcallback();
                });
            },
            (xcallback) => {
                self.disableDefunctWorkers(workers, xcallback);
            },
            (xcallback) => {
                self.unassignWaitingTopologies(workers, xcallback);
            },
            (xcallback) => {
                var leader_cnt = workers
                    .filter(x => x.lstatus == intf.Consts.WorkerLStatus.leader)
                    .length;
                if (leader_cnt > 0) {
                    res.leadership_status = intf.Consts.LeadershipStatus.ok;
                }
                xcallback();
            }
        ], (err) => {
            if (err)
                return callback(err);
            callback(null, res);
        });
    }
}
exports.TopologyLeader = TopologyLeader;
//# sourceMappingURL=topology_leader.js.map