
import * as topology_compiler from "../topology_compiler";
import * as tl from "../topology_local";
import * as intf from "../topology_interfaces";

/**
 * This class acts as wrapper for local topology when
 * it is run in child process. It handles communication with parent process.
 */
class TopologyLocalWrapper {

    private name: string;
    private topology_local: tl.TopologyLocal;

    /** Constructor that sets up call routing */
    constructor() {
        let self = this;
        this.topology_local = new tl.TopologyLocal();
        process.on('message', (msg) => {
            self.handle(msg);
        });
    }

    /** Starts infinite loop by reading messages from parent or console */
    start() {
        let self = this;
        // process.stdin.addListener("data", function (d) {
        //     try {
        //         d = d.toString().trim();
        //         let i = d.indexOf(" ");
        //         if (i > 0) {
        //             self._handle({
        //                 cmd: d.substr(0, i),
        //                 data: JSON.parse(d.substr(i))
        //             });
        //         } else {
        //             self._handle({ cmd: d, data: {} });
        //         }
        //     } catch (e) {
        //         console.error(e);
        //     }
        // });
    }

    /** Internal main handler for incoming messages */
    private handle(msg: intf.ParentMsg) {
        let self = this;
        if (msg.cmd === intf.ParentMsgCode.init) {
            console.log("Initializing topology", msg.data.general.name);
            self.name = msg.data.general.name;
            let compiler = new topology_compiler.TopologyCompiler(msg.data);
            compiler.compile();
            let topology = compiler.getWholeConfig();
            self.topology_local.init(topology, (err) => {
                self.topology_local.run();
                self.send(intf.ChildMsgCode.response_init, { err: err });
            });
        }
        if (msg.cmd === intf.ParentMsgCode.run) {
            self.topology_local.run();
            self.send(intf.ChildMsgCode.response_run, {});
        }
        if (msg.cmd === intf.ParentMsgCode.pause) {
            self.topology_local.pause((err) => {
                self.send(intf.ChildMsgCode.response_pause, { err: err });
            });
        }
        if (msg.cmd === intf.ParentMsgCode.shutdown) {
            console.log("Shutting down topology", self.name);
            self.topology_local.shutdown((err) => {
                self.send(intf.ChildMsgCode.response_shutdown, { err: err });
                //process.exit(0); - will be killed by parent process
                setTimeout(() => { 
                    console.log("$$$ about to exit process from child")
                    process.exit(0); 
                }, 100);
            });
        }
    }

    /** Sends command to parent process.
     * @param {string} cmd - command to send
     * @param {Object} data - data to send
     */
    private send(cmd: intf.ChildMsgCode, data: any) {
        if (process.send) {
            process.send({ cmd: cmd, data: data });
        } else {
            // we're running in dev/test mode as a standalone process
            console.log("Sending command", { cmd: cmd, data: data });
        }
    }
}

/////////////////////////////////////////////////////////////////////////////////////

// start worker and listen for messages from parent
let wr = new TopologyLocalWrapper();
wr.start();
