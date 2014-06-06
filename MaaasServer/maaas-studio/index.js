﻿// Maaas Studio module
//
// http://justjs.com/posts/creating-reusable-express-modules-with-their-own-routes-views-and-static-assets
//
var logger = require('log4js').getLogger("maaas-studio");
var express = require('express');
var path = require('path');
var wait = require('wait.for');

var hbs = require('express-hbs');

var maaasApi = require('../maaas-api');

var render = hbs.create().express3({
    // partialsDir: __dirname + '/views/partials',
    layoutsDir: __dirname + '/views/layouts',
    defaultLayout: __dirname + '/views/layouts/default.hbs',
    contentHelperName: 'content'
});

var edit = require('./routes/edit');
var debugApi = require('./lib/ws-debug-server');

// Constructor
//
var MaaasStudio = function(basePath)
{
	this.basePath = basePath;
	this.apiProcessors = [];
};

// Called before the Express router or any routes are added to the app.  This is a good time to add any
// static middleware.
//
MaaasStudio.prototype.addMiddleware = function(expressApp)
{
	logger.info("Adding static path from basePath: " + this.basePath);
	logger.info("Static path is: " + path.join(__dirname, 'public'));
	expressApp.use(this.basePath, express.static(path.join(__dirname, 'public')));
}

MaaasStudio.prototype.addRoutes = function(expressApp, checkAuth) 
{
	self = this;

	// We need to process /sandbox and /module (get and put) on a fiber, since they use wait.for to do async processing...
	//
	expressApp.get(this.basePath + '/:appName/sandbox', checkAuth, function(req,res)
	{
	    wait.launchFiber(edit.edit, self, req.params.appName, req, res); //handle in a fiber, keep node spinning
	});

	expressApp.get(this.basePath + '/:appName/module', checkAuth, function(req,res)
	{
	    wait.launchFiber(edit.loadModule, self, req.params.appName, req, res); //handle in a fiber, keep node spinning
	});

	expressApp.post(this.basePath + '/:appName/module', checkAuth, function(req,res)
	{
	    wait.launchFiber(edit.saveModule, self, req.params.appName, req, res); //handle in a fiber, keep node spinning
	});
}

MaaasStudio.prototype.addApiProcessor = function(appName, apiProcessor)
{
	this.apiProcessors[appName] = 
	{
		apiProcessor: apiProcessor,
		moduleStore: maaasApi.createServiceFromSpec(apiProcessor.moduleStoreSpec)
	}
}

MaaasStudio.prototype.getApiProcessor = function(appName)
{
	return this.apiProcessors[appName].apiProcessor;
}

MaaasStudio.prototype.getModuleStore = function(appName)
{
	return this.apiProcessors[appName].moduleStore;
}

MaaasStudio.prototype.render = function(templateName, locals, res)
{
	var dirname = path.join(__dirname, '/views');

	locals.settings = { views: dirname };

	render(path.join(dirname, templateName + '.hbs'), locals, function(err, html) 
	{
		if (err)
		{

		}
		else
		{
			res.send(html);
		}
    });
}

MaaasStudio.prototype.processWebSocket = function(request, socket, body)
{
    debugApi.processWebSocket(request, socket, body);
}

module.exports = MaaasStudio;