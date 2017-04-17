import * as path from "path";
import * as cp from "child_process";
import * as intf from "../topology_interfaces";

/**
 * This class acts as a proxy for local topology inside parent process.
 */
export class TopologyLocalProxy {

    _init_cb: intf.SimpleCallback;
    _run_cb: intf.SimpleCallback;
    _pause_cb: intf.SimpleCallback;
    _shutdown_cb: intf.SimpleCallback;
    _was_shut_down: boolean;
    _child_exit_callback: intf.SimpleCallback;
    _child: cp.ChildProcess;

    /** Constructor that sets up call routing */
    constructor(child_exit_callback: intf.SimpleCallback) {
        let self = this;

        this._init_cb = null;
        this._run_cb = null;
        this._pause_cb = null;
        this._shutdown_cb = null;
        this._was_shut_down = false;
        this._child_exit_callback = child_exit_callback || (() => { });
        this._child = cp.fork(path.join(__dirname, "topology_local_wrapper"), []);

        self._child.on("message", (msgx) => {
            let msg = msgx as intf.ChildMsg;
            if (msg.cmd == intf.ChildMsgCode.response_init) {
                if (self._init_cb) {
                    self._init_cb(msg.data.err);
                    self._init_cb = null;
                }
            }
            if (msg.cmd == intf.ChildMsgCode.response_run) {
                if (self._run_cb) {
                    self._run_cb(msg.data.err);
                    self._run_cb = null;
                }
            }
            if (msg.cmd == intf.ChildMsgCode.response_pause) {
                if (self._pause_cb) {
                    self._pause_cb(msg.data.err);
                    self._pause_cb = null;
                }
            }
            if (msg.cmd == intf.ChildMsgCode.response_shutdown) {
                if (self._shutdown_cb) {
                    self._shutdown_cb(msg.data.err);
                    self._shutdown_cb = null;
                    self._was_shut_down = true;
                }
                self._child.kill();
            }
        });

        self._child.on("error", (e) => {
            if (self._was_shut_down) return;
            self._callPendingCallbacks(e);
            self._child_exit_callback(e);
            self._callPendingCallbacks2(e);
        });
        self._child.on("close", (code) => {
            if (self._was_shut_down) return;
            let e = new Error("CLOSE Child process exited with code " + code);
            self._callPendingCallbacks(e);
            if (code === 0) {
                e = null;
            }
            self._child_exit_callback(e);
            self._callPendingCallbacks2(e);
        });
        self._child.on("exit", (code) => {
            if (self._was_shut_down) return;
            let e = new Error("EXIT Child process exited with code " + code);
            self._callPendingCallbacks(e);
            if (code === 0) {
                e = null;
            }
            self._child_exit_callback(e);
            self._callPendingCallbacks2(e);
        });
    }

    /** Calls all pending callbacks with given error and clears them. */
    _callPendingCallbacks(e: Error) {
        if (this._init_cb) {
            this._init_cb(e);
            this._init_cb = null;
        }
        if (this._run_cb) {
            this._run_cb(e);
            this._run_cb = null;
        }
        if (this._pause_cb) {
            this._pause_cb(e);
            this._pause_cb = null;
        }
    }

    /** Calls pending shutdown callback with given error and clears it. */
    _callPendingCallbacks2(e: Error) {
        if (this._shutdown_cb) {
            this._shutdown_cb(e);
            this._shutdown_cb = null;
        }
    }

    /** Sends initialization signal to underlaying process */
    init(config: any, callback: intf.SimpleCallback) {
        if (this._init_cb) {
            return callback(new Error("Pending init callback already exists."));
        }
        this._init_cb = callback;
        this._send({ cmd: intf.ParentMsgCode.init, data: config });
    }

    /** Sends run signal to underlaying process */
    run(callback: intf.SimpleCallback) {
        if (this._run_cb) {
            return callback(new Error("Pending run callback already exists."));
        }
        this._run_cb = callback;
        this._send({ cmd: intf.ParentMsgCode.run, data: {} });
    }

    /** Sends pause signal to underlaying process */
    pause(callback: intf.SimpleCallback) {
        if (this._pause_cb) {
            return callback(new Error("Pending pause callback already exists."));
        }
        this._pause_cb = callback;
        this._send({ cmd: intf.ParentMsgCode.pause, data: {} });
    }

    /** Sends shutdown signal to underlaying process */
    shutdown(callback: intf.SimpleCallback) {
        if (this._shutdown_cb) {
            return callback(new Error("Pending shutdown callback already exists."));
        }
        this._shutdown_cb = callback;
        this._send({ cmd: intf.ParentMsgCode.shutdown, data: {} });
    }

    /** Internal method for sending messages to child process */
    _send(msg: intf.ParentMsg) {
        this._child.send(msg);
    }
}
