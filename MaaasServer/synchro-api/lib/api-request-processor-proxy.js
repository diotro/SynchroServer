var logger = require('log4js').getLogger("api-request-processor-proxy");

var wait = require('wait.for');

var apiRequestProcessorModule = require("./api-request-processor");
var apiRequestProcessor;

function createApiRequestProcessor(params)
{
	logger.info("Initializing API request processor");
	apiRequestProcessor = apiRequestProcessorModule.createApiRequestProcessorAsync(params);
	logger.info("Done initializing API request processor");

	// Listen for messages from the parent process...
	//
	process.on('message', function(message, handle) 
	{
	    // Process messages (commands) from the parent process...
	    //
	    switch (message.cmd)
	    {
	        case "processHttpRequest":
	            apiRequestProcessor.processHttpRequest(message.request, function(err, data)
	            {
	                // Signal the parent process that we're done, and pass the response data
	                process.send({type: "httpRequest", id: message.id, err: err, data: data});
	            });
	            break;

	        case "processWebSocket":
	            message.request.socket = handle;
	            apiRequestProcessor.processWebSocket(message.request, handle, message.body);
	            break;

	        case "reloadModule":
	            wait.launchFiber(apiRequestProcessor.reloadModule, message.moduleName); //handle in a fiber
	            break;
	    }
	});

	logger.info("Sending process started message");
	// Signal the parent process that the api request processor is loaded and ready
    process.send({type: "status", status: "Started"});
}

exports.postProcessHttpRequest = function(request, response, err, data)
{
	return apiRequestProcessorModule.postProcessHttpRequest(request, response, err, data);
}

// This module is launched as a forked process, and it is also loaded inproc by the parent in order to call 
// postProcessHttpRequest inproc (from the main thread).  Caution must be exercised, and specifically, the api
// request processor should only be created by this module for the instance of the module that is going to call
// into it (we want to avoid unnecesarily launching two module loaders/manangers in sepatate processes).
//
if (!module.parent)
{
	// Maybe we just hook stdout/stderr when we're running user modules, so we can pipe just that to the debugger.
	//
	// https://gist.github.com/pguillory/729616
	/*
	process.stdout.write = (function(write) {
	    return function(string, encoding, fd) {
	        write.apply(process.stdout, arguments)
	        // Do whatever else you want with "string" here...
	    }
	})(process.stdout.write);
	*/

	// Parse process params...
	//
	var filename = process.argv[1];           // argv[1] is the filename of this file
	var params = JSON.parse(process.argv[2]); // argv[2] is the params we passed in (JSON encoded)

	// Need to reconfigure log4js here (log4js config is at the process level and not inherited)
	var log4js = require('log4js');

	var loggingParams = JSON.parse(process.argv[3]); // argv[3] is the logging config we passed from the parent process (JSON encoded)
	log4js.configure(loggingParams);

	logger.info("Forked API child process started started: " + filename);

	wait.launchFiber(createApiRequestProcessor, params);
}
