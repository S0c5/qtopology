"use strict";
var http = require('http');
///////////////////////////////////////////////////////////////////////////
// Bare minimum REST server
// Utility function that reads requests body
function withBody(handler) {
    return function (req, resp) {
        var input = "";
        req.on("data", function (chunk) { input += chunk; });
        req.on("end", function () { req.body = input; handler(req, resp); });
    };
}
;
// Utility function for returning response
function handleResponse(result, response) {
    console.log("Sending response", result);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
}
// Utility function for returning error response
function handleError(error, response) {
    console.log("Sending ERROR", error);
    response.writeHead(500);
    response.end(error);
}
// registered handlers
var handlers = {};
/** For registering simple handlers */
function addHandler(addr, callback) {
    handlers[addr] = callback;
}
/** For running the server */
function run(options) {
    var port = options.port || 3000;
    var server = http.createServer(withBody(function (req, resp) {
        // get the HTTP method, path and body of the request
        var method = req.method;
        var addr = req.url;
        var data = null;
        console.log("Handling", addr);
        try {
            data = JSON.parse(req.body);
        }
        catch (e) {
            handleError("" + e, resp);
            return;
        }
        console.log("Handling", req.body);
        if (!handlers[addr]) {
            handleError("Unknown request: \"" + addr + "\"", resp);
        }
        else {
            try {
                handlers[addr](data, function (err, data) {
                    if (err)
                        return handleError(err, response);
                    handleResponse(data, resp);
                });
            }
            catch (e) {
                handleError("" + e, resp);
                return;
            }
        }
    }));
    server.listen(port, function (err) {
        if (err) {
            console.log("Error while starting server on port", port);
            console.log("Error:", err);
        }
        else {
            console.log("Server running on port", port);
        }
    });
}
////////////////////////////////////
exports.addHandler = addHandler;
exports.run = run;
