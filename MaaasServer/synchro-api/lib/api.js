﻿var lodash = require("lodash");

var objectMonitor = require('./objectmon');
var util = require('./util');

var logger = require('log4js').getLogger("api");

var wait = require('wait.for');

var filter = require('./filter');

// Transaction id:   Monotonically increasing value, client generated, used to identify a given request or chain of requests
// Instance id:      Monotonically increasing value, server generated, used to identify a module instance
// Instance version: Monotonically increasing value, server generated, starting at 1, used to identify the version of the module instance view model
//
// Roadmap of members for Session and context
// ----------------------------------------------
//
// Session
//     id
//     DeviceMetrics 
//     ViewMetrics
//     UserData (this is what is passed to user code as the "session" param)
//     ModuleInstance
//         path
//         instanceId
//         viewIsDynamic
//         viewHash (present if viewIsDynamic)
//         ClientViewModel
//             instanceVersion
//             ViewModel
//         ServerViewModel (present only when co-processing)
//             ViewModel
//
// context
//     session
//     request
//     response
//     LocalViewModel
//         instanceId
//         ViewModel
//

// Roadmap of request/response
// ------------------------------
//
// Request
//      DeviceMetrics (optional, typically sent once at start of session)
//      ViewMetrics (optional, typically sent at start of session and on change, such as rotation)
//      TransactionId (client generated, used to match reply to request)
//      Path
//      InstanceId
//      InstanceVersion
//      Mode
//      <other params, as appropriate per Mode>
//
// Response
//      TransactionId
//      InstanceId
//      InstanceVersion
//      View
//      ViewModel/ViewModelDeltas
//      NextRequest (for multi-step transactions, particularly subsequent LoadPage and Continue operations)
//          <fully populated request, including TransactionId which will be unchanged from originating request>
//      Error
//

// Used to capture exceptions thrown from user code
//
function UserCodeError(method, error) 
{
    Error.call(this);
    Error.captureStackTrace(this, arguments.callee);
    this.message = "UserCode error in method: " + method + " - " + error.message;
    this.name = 'UserCodeError';
    this.method = method,
    this.error = error;

    logger.error(this.message);
}
UserCodeError.prototype.__proto__ = Error.prototype;

// Used for logical client errors (essentially, client bugs - conditions caused by the client that should
// never happen, even considering dropped connections, lost requests/responses, and other normal/predictable
// client/server sync issues).
//
function ClientError(msg) 
{
    Error.call(this);
    Error.captureStackTrace(this, arguments.callee);
    this.message = "Client error - " + msg;
    this.name = 'ClientError';

    logger.error(this.message);
}
ClientError.prototype.__proto__ = Error.prototype;

// Used for client/server sync errors
//
function SyncError(msg, request)
{
    Error.call(this);
    Error.captureStackTrace(this, arguments.callee);
    this.message = "Sync error - " + msg;
    this.name = 'SyncError';
    this.request = request;

    logger.error(this.message);
}
SyncError.prototype.__proto__ = Error.prototype;

// We use a custom "Context" object type so that we can validate the parameter when passed in from user code
//
function Context(session, request, response)
{
    this.session = session;
    this.request = request;
    this.response = response;
};

function BackStack(session)
{
    this.session = session;
};

BackStack.prototype.init = function(route)
{
    this.session.BackStack = [{ route: route }];
}

BackStack.prototype.getSize = function()
{
    return this.session.BackStack.length;
}

BackStack.prototype.getCurrent = function()
{
    if (this.session.BackStack.length > 0)
    {
        return this.session.BackStack[this.session.BackStack.length-1];
    }

    // Backstack is empty
    //
    return null;

}

BackStack.prototype.updateCurrent = function(route, params)
{
    this.session.BackStack[this.session.BackStack.length-1] = { route: route };
    var current = this.getCurrent();
    if (params)
    {
        current.params = lodash.cloneDeep(params);
    }
}

BackStack.prototype.pushCurrentAndAddNew = function(route, params, state)
{
    var current = this.getCurrent();
    if (state)
    {
        current.state = lodash.cloneDeep(state);
    }
    this.session.BackStack.push({ route: route });
    var current = this.getCurrent();
    if (params)
    {
        current.params = lodash.cloneDeep(params);
    }
}

BackStack.prototype.pop = function()
{
    this.session.BackStack.pop();
    return this.getCurrent();
}

BackStack.prototype.popTo = function(route)
{
    for (var n = this.session.BackStack.length - 1; n >= 0; n--)
    {
        if (this.session.BackStack[n].route == route)
        {
            this.session.BackStack = this.session.BackStack.slice(0, n + 1);
            return this.getCurrent();
        }
    }

    // route not found
    //
    return null;
}


function getViewModel(routeModule, context, session, params, state)
{
    viewModel = {};
    if (routeModule.InitializeViewModel)
    {
        logger.info("Initializing view model");

        try 
        {
            // USERCODE
            viewModel = routeModule.InitializeViewModel(context, session.UserData, params, state);
        }
        catch (e)
        {
            throw new UserCodeError("InitializeViewModel", e);
        }
    }

    return viewModel;
}

function getView(routeModule, context, session, viewModel, isViewMetricUpdate)
{
    isViewMetricUpdate = isViewMetricUpdate || false;

    var view = {};

    if (routeModule.View)
    {
        view = filter.filterView(session.DeviceMetrics, session.ViewMetrics, viewModel, routeModule.View);
    }

    if (routeModule.InitializeView)
    {
        var metrics = { DeviceMetrics: context.session.DeviceMetrics, ViewMetrics: context.session.ViewMetrics };

        try 
        {
            // USERCODE
            view = routeModule.InitializeView(context, session.UserData, viewModel, view, metrics, isViewMetricUpdate);
        }
        catch (e)
        {
            throw new UserCodeError("InitializeView", e);
        }
    }

    return view;
}

function isCurrentModuleInstance(context, instanceId)
{
    return (instanceId && (context.session.ModuleInstance.instanceId == instanceId));
}

function isBackAvailable(context, routeModule)
{
    // Determine if "back" is available based on either an OnBack handler, or if not provided, whether
    // the back stack supports pop.  Report that to client.
    //
    var backStack = new BackStack(context.session)
    return ((routeModule.OnBack instanceof Function) || backStack.getSize() > 1);
}

function populateNewPageResponse(synchroApi, route, routeModule, context, params, state)
{    
    var viewModel = getViewModel(routeModule, context, context.session, params, state);
    var view = getView(routeModule, context, context.session, viewModel);

    // Note: This will have the side-effect of removing the stored ServerViewModel, which is intentional and appropriate (as 
    //       this is a new module instance and any stored ServerViewModel is obsolete).
    //
    context.session.ModuleInstance =
    {
        path: route,
        instanceId: ((context.session.ModuleInstance && context.session.ModuleInstance.instanceId) || 0) + 1,
        ClientViewModel:
        {
            instanceVersion: 0,
            ViewModel: viewModel
        }
    } 

    // Note: we're only ever going to use the hash for dynamic views, so no use in computing it otherwise.
    //
    if (view.dynamic)
    {
        context.session.ModuleInstance.dynamic = true;
        context.session.ModuleInstance.viewHash = util.jsonHash(view);
    }

    synchroApi.sessionStore.putSession(context.session); // !!! Async, could temp fail

    context.navigatedToInstanceId = context.session.ModuleInstance.instanceId;

    // Initialize the response
    //
    context.response.Path = route;
    context.response.View = view;
    context.response.Back = isBackAvailable(context, routeModule);

    if (routeModule.LoadViewModel)
    {
        context.response.NextRequest = 
        {
            Path: route,
            TransactionId: context.request.TransactionId,
            InstanceId: context.session.ModuleInstance.instanceId,
            InstanceVersion: 1,
            Mode: "LoadPage"
        }
    }
}

function sendUpdate(synchroApi, context, isInterim)
{
    if (context.obsoleteProcessor)
    {
        // We are ignoring obsolete view model updates for this processor.
        //
        logger.info("Ignoring obsolete view model updates for processor");
        return;
    }

    context.interimUpdate = isInterim;

    var channelId = context.session.id + ":" + context.request.TransactionId;

    if (synchroApi.readerWriter.isWritePending(channelId))
    {
        // If there is currently a write pending on this channel, no need to take any action here.  Any view model
        // changes made since that original update was posted will still be picked up when it gets sent.
        //
        // If the posted update was a partial/interim and the current update is a final/complete, that will get
        // picked up when the write is satisfied (per the context.interimUpdate set above) and will result in a 
        // final/complete update being sent.
        //
        logger.info("Update - request already pending, no action taken");
        return;
    }

    // Post the response write
    //
    logger.info("Posting write for session:transactionId - " + channelId);
    synchroApi.readerWriter.writeAsync(channelId, function(err, writeData)
    {
        if (err)
        {
            // !!! Write failed.  Handle.  Test.
            //
            logger.error("writeAsync err: " + err);  
        }
        else
        {
            // We don't want to compute/update the response until we're ready to send it (which is now), since the 
            // response type or view model could have changed subsequent to when the write was originally posted.
            //
            logger.info("writeAsync posting to reader");

            context.response.TransactionId = context.request.TransactionId;

            if (!context.response.Error)
            {
                if (context.request.Mode == "Resync")
                {
                    logger.info("Resync - sending current view model");
                    context.response.ViewModel = context.session.ModuleInstance.ClientViewModel.ViewModel
                }
                else if (isCurrentModuleInstance(context, context.LocalViewModel.instanceId))
                {
                    if (context.session.ModuleInstance.ClientViewModel.instanceVersion == 0)
                    {
                        // We have not sent the client a view model yet, so we need to send them the whole view model
                        //
                        logger.info("Sending view model for page, after applying local client changes");
                        context.response.ViewModel = context.LocalViewModel.ViewModel;
                        context.session.ModuleInstance.ClientViewModel.ViewModel = lodash.cloneDeep(context.LocalViewModel.ViewModel);
                        context.session.ModuleInstance.ClientViewModel.instanceVersion = 1;
                    }
                    else
                    {
                        // We just want to send the client any deltas
                        //
                        logger.info("Sending view model updates for page");
                        var viewModelUpdates = objectMonitor.getChangeList(null, context.session.ModuleInstance.ClientViewModel.ViewModel, context.LocalViewModel.ViewModel);
                        if (viewModelUpdates.length > 0)
                        {
                            context.response.ViewModelDeltas = viewModelUpdates;
                            context.session.ModuleInstance.ClientViewModel.ViewModel = lodash.cloneDeep(context.LocalViewModel.ViewModel);

                            // Note that we're only incrementing the instance version if we actually have any changes
                            //
                            context.session.ModuleInstance.ClientViewModel.instanceVersion++;
                        }                        
                    }

                    if (context.interimUpdate)
                    {
                        logger.info("Setting NextRequest to 'Continue' for interim update");
                        context.response.NextRequest = 
                        {
                            Path: context.request.Path,
                            TransactionId: context.request.TransactionId,
                            InstanceId: context.session.ModuleInstance.instanceId,
                            InstanceVersion: context.session.ModuleInstance.ClientViewModel.instanceVersion,
                            Mode: "Continue"
                        }
                    }
                }
                else
                { 
                    if (isCurrentModuleInstance(context, context.navigatedToInstanceId))
                    {
                        // This processor navigated to the current page (we know this was not a "Page" request that originated with
                        // the current instance since we failed the LocalViewModel  isCurrentModuleInstance test above).  We don't 
                        // want to send any changes that it might have made to its own view model, and instead just send the view 
                        // model for the page to which it navigated.
                        //
                        logger.info("Sending view model for page navigated to, not applying local client changes");
                        context.response.ViewModel = lodash.cloneDeep(context.session.ModuleInstance.ClientViewModel.ViewModel);
                        context.session.ModuleInstance.ClientViewModel.instanceVersion = 1;
                    }
                    else
                    {
                        // This processor is not on the instance that it started on, or one that it navigated to.  It is likely that
                        // another processor on the same instance navigated to a new page.  Any changes to the local view model are obsolete.
                        // By not sending any ViewModel or ViewModelDeltas in the response, the response becomes a NOOP on the client.
                        //
                        // We want to cancel any NextRequest that might be present (such as LoadPage), since those would be for an
                        // obsolete/outdated page anyway.
                        //
                        delete context.response.NextRequest;
                    }

                    // This processor is not on the current instance, so any future updates to its view model will be obsolete.  For
                    // this reason, we want to ignore any future update attempts from this processor.
                    //
                    context.obsoleteProcessor = true;
                }

                context.response.InstanceId = context.session.ModuleInstance.instanceId;
                context.response.InstanceVersion = context.session.ModuleInstance.ClientViewModel.instanceVersion;
            }

            // logger.info("Sending response: " + util.formatJSON(context.response));
            writeData(context.response);

            if (!context.response.Error)
            {            
                // Update the server view model, if any
                //
                if (context.session.ModuleInstance.ServerViewModel)
                {
                    // Note: If there is a ServerViewModel, it means we have not navigated away from the ClientViewModel instance,
                    //       and since they are guaranteed to be on the same instance, and that is unrelated to the current local
                    //       instance, we are safe to do this update in all cases.
                    //
                    context.session.ModuleInstance.ServerViewModel.ViewModel = lodash.cloneDeep(context.session.ModuleInstance.ClientViewModel.ViewModel);
                }

                logger.info("Putting session after potentially updating client/server view models and incrementing instanceVersion");
                synchroApi.sessionStore.putSession(context.session); // !!! Async, could temp fail

                // If this is an interim update and the NextRequest wasn't cancelled above...
                //
                if (context.interimUpdate && context.response.NextRequest)
                {
                    // Update response and view model state in preparation for subsequent update
                    //
                    context.response = 
                    { 
                        Path: context.request.Path,
                    }

                    // If we're going to keep going on this processor, update the LocalViewModel to the ClientViewModel version so
                    // that the continued processing will start from that baseline (for the purpose of computing future diffs)
                    //
                    util.assignNewContents(context.LocalViewModel.ViewModel, lodash.cloneDeep(context.session.ModuleInstance.ClientViewModel.ViewModel));
                }
            }
        }
    });
}

function initLocalViewModel(context)
{
    // Initialize the local view model that this module instance will use during processing of this request.  We only evaluate
    // the local view model for changes on client update if we haven't navigated away from this page/instance.
    //
    if (context.session.ModuleInstance)
    {
        context.LocalViewModel = { instanceId: context.session.ModuleInstance.instanceId };

        if (context.session.ModuleInstance.ServerViewModel)
        {
            // If there is a ServerViewModel, then it represents a live processing state of another processor running against
            // this module instance that has shared this version of the view model before yielding, so we will use it in order
            // to pick up any changes that process has made.
            //
            context.LocalViewModel.ViewModel = lodash.cloneDeep(context.session.ModuleInstance.ServerViewModel.ViewModel);
        }
        else if (context.session.ModuleInstance.ClientViewModel)
        {
            // The normal mode is that we initialize our local view model to the clients version of the view model
            //
            context.LocalViewModel.ViewModel = lodash.cloneDeep(context.session.ModuleInstance.ClientViewModel.ViewModel);
        }        
    }
}

// Public API
//
var SynchroApi = function(moduleManager, sessionStore, readerWriter)
{
    this.appDefinition = null;
    this.moduleManager = moduleManager;
    this.sessionStore = sessionStore;
    this.readerWriter = readerWriter;
}

SynchroApi.prototype.isValidContext = function(context)
{
    return (context instanceof Context);
}

SynchroApi.prototype.load = function(err, appDefinition)
{
    this.appDefinition = this.moduleManager.loadModules(this);
    return this.appDefinition;
}

SynchroApi.prototype.getAppDefinition = function()
{
    logger.info("Sending appDefinition: " + this.appDefinition);
    return this.appDefinition;
}

SynchroApi.prototype.reloadModule = function(moduleName)
{
    this.moduleManager.reloadModule(moduleName);
}

// Takes a Synchro request object and returns a Synchro response object
//
SynchroApi.prototype.process = function(session, requestObject, responseObject)
{
    logger.info("Processing request: " + JSON.stringify(requestObject, null, 4));
    session.UserData = session.UserData || {};

    var context = new Context(session, requestObject, responseObject);

    context.response.Path = context.request.Path;

    var route;

    try
    {
        if (context.request.Mode == "Page")
        {
            if (context.request.Path)
            {
                route = context.request.Path;            
            }
            else
            {
                throw new ClientError("Received Mode: Page request with no Path");
            }
        }
        else if (context.request.Mode == "Resync")
        {
            // A resync is always going to get the ViewModel, or View and ViewModel, of the current instance, so the 
            // active path/route for this request will be set to that of the current instance for the Resync.
            //
            route = context.session.ModuleInstance.path;
        }
        else if (context.request.InstanceId >= 0)
        {
            if (context.session.ModuleInstance)
            {
                if (isCurrentModuleInstance(context, context.request.InstanceId))
                {
                    // At this point we've determined that the client sent this transaction regarding an instance that 
                    // is the same instance that the server is processing.  So far so good. 
                    //
                    route = context.session.ModuleInstance.path;

                    if (context.request.Path && (context.request.Path !== context.session.ModuleInstance.path))
                    {
                        throw new ClientError("Request specified current instance, but incorrect path - request path: " + 
                            context.request.Path + ", current instance path: " + context.session.ModuleInstance.path);
                    }

                    // Now let's see if the instance versions match...
                    //
                    if (!context.request.InstanceVersion)
                    {
                        throw new ClientError("Received Mode: " + context.request.Mode + " request with no InstanceVersion");
                    }
                    else if (context.request.InstanceVersion != context.session.ModuleInstance.ClientViewModel.instanceVersion)
                    {
                        // !!! This request has an InstanceId and InstanceVersion.  It matches the current instance, but refers to
                        //     a different (presumably, previous) version of the instance.  
                        //
                        //     This could be something as simple as a user clicking a button that triggers a command two or more
                        //     times in quick succession (the second click is sent from the client before the response to the first
                        //     click is received/processed by the client).  Or it could be a case where an instance update did not
                        //     make it back to the client for some reason, meaning that the client and server will not be in sync
                        //     until a subsequent request against this instance (assuming it is allowed) triggers a successful 
                        //     update of the client.
                        //
                        //     There are certain cases where we would explicitly want to allow requests like this.  For example, if
                        //     we had an "increment" button that the user could wham on as fast as they wanted, it shouldn't matter
                        //     what version of the view model the client has.  A more sophisticated example is that we are doing an
                        //     asynchronous operation that is sending periodic interim view model updates to show percent completion.
                        //     If the user hits the "cancel" button, we want the cancel command to get through whether or not the 
                        //     view model on the client was current at the time they hit it.
                        //
                        //     We won't see Page requests here. And LoadPage requests can only be triggered by a response that includes
                        //     the initial view model for the page, so they can never be out of sync.  We are talking about Update, 
                        //     ViewUpdate, and Command requests.  Update requests will always contain view model updates.  ViewUpdate
                        //     and Command requests may or may not contain view model updates.  We might distinguish between requests
                        //     which contain view model updates and those that do not when deciding how to handle this situation.
                        //
                        //     We could also expose the version mismatch to the user code (perhaps via a Synchro.isCurrentVersion)
                        //     and pass the responsibility of handling this condition to the user.  If so, we'd need to also make 
                        //     sure the user code could trigger a resync or take whatever other action might be appropriate.
                        //
                        //     Right now, this request will just being processed...
                        //
                        logger.warn("Received request for previous version of current instance (request version: " +
                            context.request.InstanceVersion  + ", current version: " +  context.session.ModuleInstance.ClientViewModel.instanceVersion);
                    }
                }
                else
                {
                    // This request has an InstanceId but it doesn't match the current instanceId in the session, so
                    // this is an obsolete request (for an instance that has been navigated away from).
                    //
                    // There are two types of cases where this could happen.  One is that a processor could have navigated 
                    // to a new page/instance, but before the response could get back to the client and be processed by the
                    // client, the client sent an additional request.  The simplest case of this might be the user clicking
                    // a button that triggered a navigation command two or more times in quick succession.  The first request
                    // gets processed, and navigates to a new page.  If a subsequent request is sent before the response 
                    // to the first request has been received and processed by the client, then that request will be for the
                    // previous instance.  This is a case that could be safely ignored, but only the client can know that.
                    //
                    // Also consider a case where the client submits a request that results in navigation to a new page,
                    // but for whatever reason, that response never reaches the client.  Now the server thinks it's on the
                    // new page, but the client is actually on the old page.  If the client detects this condition, it can
                    // recover by requesting a "Resync".
                    //
                    throw new SyncError("Received request for non-current instance id: " + context.request.InstanceId, context.request);
                }
            }
            else
            {
                // The client provided an InstanceId, but the server doesn't have an active instance. The only way we should
                // be able to arrive at this situation (apart from client error) is if the sesssion has been lost/corrupted.
                // The only real way to recover safely from this situation is for the client to initiate an app-level reset.
                // The response from this error will allow the client to detect this condition (based on the lack of an 
                // InstanceId), which should cause the client to clear any client state and "restart the app" by requesting
                // the main app entry page).
                //
                throw new SyncError("Received request for instance id: " + context.request.InstanceId + ", but server has no active instance", context.request);
            }
        }
        else
        {
            throw new ClientError("Received Mode: " + context.request.Mode + " request with no InstanceId");
        }

        logger.info("Processing path " + route);

        // Store device metrics in session if provided (should only be at start of session)
        //
        if (context.request.DeviceMetrics)
        {
            context.session.DeviceMetrics = context.request.DeviceMetrics;
        }

        // Update view metrics in session if provided (happens at start of session and whenever orientation or other view state changes on client)
        //
        if (context.request.ViewMetrics)
        {
            context.session.ViewMetrics = context.request.ViewMetrics;
        }

    	var routeModule = this.moduleManager.getModule(route);
        if (!routeModule)
        {
            throw new ClientError("No route found for path: " + context.request.Path);
        }

        logger.info("Found module for route: " + route);
        
        if (context.request.ViewModelDeltas)
        {
            logger.info("ViewModel before deltas: " + viewModel);

            // Record the current state of view model so we can diff it after apply the changes from the client,
            // and use that diff to see if there were any changes, so that we can then pass them to the OnViewModelChange
            // handler (for the "view" mode, indicating changes that were made by/on the view).
            //
            var viewModelBeforeUpdate = lodash.cloneDeep(context.session.ModuleInstance.ClientViewModel.ViewModel);

            // Now apply the changes from the client...
            for (var i = 0; i < context.request.ViewModelDeltas.length; i++) 
            {
                logger.info("View Model change from client - path: " + context.request.ViewModelDeltas[i].path + ", value: " + context.request.ViewModelDeltas[i].value);
                util.setObjectProperty(context.session.ModuleInstance.ClientViewModel.ViewModel, context.request.ViewModelDeltas[i].path, context.request.ViewModelDeltas[i].value);
                if (context.session.ModuleInstance.ServerViewModel)
                {
                    util.setObjectProperty(context.session.ModuleInstance.ServerViewModel.ViewModel, context.request.ViewModelDeltas[i].path, context.request.ViewModelDeltas[i].value);                    
                }
                util.setObjectProperty(viewModel, context.request.ViewModelDeltas[i].path, context.request.ViewModelDeltas[i].value);
            }
            
            // Update the session to reflect changes to ClientViewModel (and possibly ServerViewModel) from client
            //
            this.sessionStore.putSession(context.session); // !!! Async, could temp fail

            // Getting this here allows us to track any changes made by server logic (in change notifications or commands)
            //
            initLocalViewModel(context);

            // If we have a view model change listener for this route, analyze changes, and call it as appropriate.
            //
            if (routeModule.OnViewModelChange)
            {
                // Get the changelist for the callback, but only call if there are any changes
                //
                var viewModelUpdates = objectMonitor.getChangeList(null, viewModelBeforeUpdate, context.LocalViewModel.ViewModel);
                if (viewModelUpdates && (viewModelUpdates.length > 0))
                {
                    try 
                    {
                        // USERCODE
                        routeModule.OnViewModelChange(context, context.session.UserData, context.LocalViewModel.ViewModel, "view", viewModelUpdates);
                    }
                    catch (e)
                    {
                        throw new UserCodeError("OnViewModelChange", e);
                    }
                }
            }
        }
        else
        {
            initLocalViewModel(context);
        }

        switch (requestObject.Mode)
        {
            case "Page":
            {
                logger.info("Page request for: " + route);

                var backStack = new BackStack(context.session)
                backStack.init(route);

                populateNewPageResponse(this, route, routeModule, context);
                initLocalViewModel(context);
            }
            break;

            case "Resync":
            {
                logger.info("Resync request for: " + route);
                if ((context.request.InstanceId >= 0) && (context.request.InstanceVersion >= 0))
                {
                    // Current view model will be assigned to response in sendUpdate() below
                    //
                    if (!isCurrentModuleInstance(context, context.request.InstanceId))
                    {
                        // Client has obsolete instance, so it also needs a new view...
                        //
                        context.response.Path = route;
                        context.response.View = getView(routeModule, context, context.session, context.session.ModuleInstance.ClientViewModel.ViewModel);
                        context.response.Back = isBackAvailable(context, routeModule);
                    }
                }
                else
                {
                    throw new ClientError("Resync request did not contain InstanceID and InstanceVersion");
                }
            }
            break;

            case "LoadPage":
            {
                logger.info("Load Page request for: " + route);
                if (routeModule.LoadViewModel)
                {
                    try 
                    {
                        // USERCODE
                        routeModule.LoadViewModel(context, context.session.UserData, context.LocalViewModel.ViewModel);
                    }
                    catch (e)
                    {
                        throw new UserCodeError("LoadViewModel", e);
                    }
                }
            }
            break;

            case "Back":
            {
                if (routeModule.OnBack)
                {
                    try 
                    {
                        // USERCODE
                        routeModule.OnBack(context, context.session.UserData, context.LocalViewModel.ViewModel);
                    }
                    catch (e)
                    {
                        throw new UserCodeError("OnBack", e);
                    }
                }
                else
                {
                    // default "pop"
                    //
                    this.pop(context);
                }
            }
            break;

            case "Update": // View model update only (no command or view metric change - just data update)
            {
                logger.info("Updating view model");
            }
            break;

            case "Command":
            {
                logger.info("Running command: " + context.request.Command);

                // Only process command if it exists...
                //
                if (routeModule.Commands && routeModule.Commands[context.request.Command])
                {
                    try 
                    {
                        // USERCODE
                        routeModule.Commands[context.request.Command](context, context.session.UserData, context.LocalViewModel.ViewModel, context.request.Parameters);
                    }
                    catch (e)
                    {
                        throw new UserCodeError("Command." + context.request.Command, e);
                    }

                    // If we have a view model change listener for this route, analyze changes, and call it as appropriate.
                    //
                    if (routeModule.OnViewModelChange)
                    {
                        // Get the changelist for the callback, but only call if there are any changes
                        //
                        var viewModelUpdates = objectMonitor.getChangeList(null, context.session.ModuleInstance.ClientViewModel.ViewModel, context.LocalViewModel.ViewModel);
                        if (viewModelUpdates && (viewModelUpdates.length > 0))
                        {
                            try 
                            {
                                // USERCODE
                                routeModule.OnViewModelChange(context, context.session.UserData, context.LocalViewModel.ViewModel, "command", viewModelUpdates); 
                            }
                            catch (e)
                            {
                                throw new UserCodeError("OnViewModelChange", e);
                            }                            
                        }
                    }
                }
                else if (context.request.Command)
                {
                    throw new ClientError("Command not found: " + context.request.Command);
                }
                else
                {
                    throw new ClientError("Mode was Command, but no 'Command' was specified");
                }
            }
            break;

            case "ViewUpdate":
            {
                logger.info("View update, orientation is now: " + context.request.ViewMetrics.orientation);

                if (routeModule.OnViewMetricsChange)
                {
                    var metrics = { DeviceMetrics: context.session.DeviceMetrics, ViewMetrics: context.session.ViewMetrics };

                    try 
                    {
                        // USERCODE
                        routeModule.OnViewMetricsChange(context, context.session.UserData, context.LocalViewModel.ViewModel, metrics);
                    }
                    catch (e)
                    {
                        throw new UserCodeError("OnViewMetricsChange", e);
                    }                            

                    // If we have a view model change listener for this route, analyze changes, and call it as appropriate.
                    //
                    if (routeModule.OnViewModelChange)
                    {
                        // Get the changelist for the callback, but only call if there are any changes
                        //
                        var viewModelUpdates = objectMonitor.getChangeList(null, context.session.ModuleInstance.ClientViewModel.ViewModel, context.LocalViewModel.ViewModel);
                        if (viewModelUpdates && (viewModelUpdates.length > 0))
                        {
                            try 
                            {
                                // USERCODE
                                routeModule.OnViewModelChange(context, context.session.UserData, context.LocalViewModel.ViewModel, "viewMetrics", viewModelUpdates);
                            }
                            catch (e)
                            {
                                throw new UserCodeError("OnViewModelChange", e);
                            }                                                        
                        }
                    }
                }

                // Only want to do the re-render processing if we haven't navigated away...
                //
                if (isCurrentModuleInstance(context, context.LocalViewModel.instanceId))
                {
                    // If dynamic view, re-render the View...
                    //
                    if (context.session.ModuleInstance.dynamic)
                    {
                        // !!! Note: getView() will call InitializeView if present, and that could potentially navigate to another
                        //     page, though that would be a dick move.  Should probably check for that and handle (user error?).
                        //

                        var view = getView(routeModule, context, context.session, context.LocalViewModel.ViewModel, true);

                        // See if the View actually changed, and if so, send the updated View back...
                        //
                        var viewHash = util.jsonHash(view);
                        if (context.session.ModuleInstance.viewHash == viewHash)
                        {
                            logger.info("Regenerated View was the same as previosuly sent View for path - no View update will be returned");
                        } 
                        else
                        {
                            // Re-rendered View did not match previously sent View.  Record the new View hash and send the updated View...
                            //
                            context.session.ModuleInstance.viewHash = viewHash;
                            context.response.View = view;
                            context.response.Back = isBackAvailable(context, routeModule);
                        }
                    }
                }

            }
            break;
        }
    }
    catch (e)
    {
        // If a user code error wraps an assertion, we need to rethrow the assertion (in order to be able to test
        // user code).
        //
        if ((e instanceof UserCodeError) && e.error.name && (e.error.name === "AssertionError"))
        {
            throw e.error;
        }

        context.response.Error = 
        {
            name: e.name,
            message: e.message
        };

        if (e instanceof SyncError)
        {
            // Add instanceId and instanceVersion to response (if we have them)
            //
            if (context.session.ModuleInstance)
            {
                context.response.InstanceId = context.session.ModuleInstance.instanceId;
                if (context.session.ModuleInstance.ClientViewModel)
                {
                    context.response.InstanceVersion = context.session.ModuleInstance.ClientViewModel.instanceVersion;
                }                
            }

            // Give the client back the request so it can analyze it (and potentially replay it)
            //
            context.response.Error.Request = e.request;
        }
    }

    sendUpdate(this, context, false);
}

// Exposed to page modules (user code)
//

// Exposed via Synchro.showMessage()
//
SynchroApi.prototype.showMessage = function(context, messageBox)
{
    context.response.MessageBox = messageBox;
}

// Exposed via Synchro.navigateTo()
//
// context - the current context
// route - the route to the new view
// params - option dictionary of params, if provided is passed to InitializeViewModel
//
SynchroApi.prototype.navigateTo = function(context, route, params)
{
    var routeModule = this.moduleManager.getModule(route);
    if (routeModule)
    {
        if (!context.obsoleteProcessor)
        {
            logger.info("Found route module - navigating to: " + route);

            var backStack = new BackStack(context.session);
            backStack.updateCurrent(route, params);

            populateNewPageResponse(this, route, routeModule, context, params);            
        }
        else
        {
            // This processor, or another one on the same instance, has already navigated away from this instance and
            // updated the client with the new instance.  This processor should really not be attempting further navigation,
            // but if it does, we're going to fail/ignore that (since the client has moved on, down a different path, and
            // abandoned the transaction that spawned this processor).
            //
            logger.error("Attempt to navigate via Synchro.navigateTo() after already navigating away from the current page");
        }
    }
    else
    {
        // Assuming this gets out of user code, it will be caught and wrapped in a UserCodeError by the processing
        // code (which has appropriate context to understand which user code function caused this, etc).
        //
        throw new Error("Attempted to navigate to page that does not exist: " + route);
    }
}

// Exposed via Synchro.pushAndNavigateTo()
//
// context - the current context
// route - the route to the new view
// params - option dictionary of params, if provided is passed to InitializeViewModel
// state - any state associate with the module being navigated away from that it requires when being navigating back to.
//
SynchroApi.prototype.pushAndNavigateTo = function(context, route, params, state)
{
    var routeModule = this.moduleManager.getModule(route);
    if (routeModule)
    {
        if (!context.obsoleteProcessor)
        {
            logger.info("Found route module - pushing to current page and navigating to: " + route);

            var backStack = new BackStack(context.session);
            backStack.pushCurrentAndAddNew(route, params, state);

            populateNewPageResponse(this, route, routeModule, context, params);
        }
        else
        {
            logger.error("Attempt to navigate via Synchro.pushAndNavigateTo() after already navigating away from the current page");
        }
    }
    else
    {
        // Assuming this gets out of user code, it will be caught and wrapped in a UserCodeError by the processing
        // code (which has appropriate context to understand which user code function caused this, etc).
        //
        throw new Error("Attempted to navigate to page that does not exist: " + route);
    }    
}

// Exposed via Synchro.pop()
//
// context - the current context
//
SynchroApi.prototype.pop = function(context)
{
    if (!context.obsoleteProcessor)
    {    
        var backStack = new BackStack(context.session);
        var stackItem = backStack.pop();
        if (stackItem == null)
        {
            throw new Error("Attempted to navigate via Synchro.pop() when back stack is empty");
        }
        else
        {
            var routeModule = this.moduleManager.getModule(stackItem.route); // Should never fail for item on backstack
            populateNewPageResponse(this, stackItem.route, routeModule, context, stackItem.params, stackItem.state);
        }
    }
    else
    {
        logger.error("Attempt to navigate via Synchro.pop() after already navigating away from the current page");
    }
}

// Exposed via Synchro.popTo()
//
// context - the current context
// route - the route to the new view to be popped to
//
SynchroApi.prototype.popTo = function(context, route)
{
    if (!context.obsoleteProcessor)
    {    
        var backStack = new BackStack(context.session);
        var stackItem = backStack.popTo(route);
        if (stackItem == null)
        {
            throw new Error("Attempted to navigate to route '" + route + "'' via Synchro.popTo() when route is not on back stack");
        }
        else
        {
            var routeModule = this.moduleManager.getModule(stackItem.route); // Should never fail for item on backstack
            populateNewPageResponse(this, stackItem.route, routeModule, context, stackItem.params, stackItem.state);
        }
    }
    else
    {
        logger.error("Attempt to navigate via Synchro.popTo() after already navigating away from the current page");
    }
}

// Exposed via Synchro.waitFor()
//
SynchroApi.prototype.waitFor = function(moduleObject, context, args)
{
    logger.info("waitFor...");

    var waitingOnCurrentInstance = true;

    // If we are processing the current client instance (meaning the client has not navigated to a new page/instance
    // since we started processing this request), write local view model to the session ServerViewModel before we
    // yield so that other processors on this instance can pick up any changes we've made relative to the baseline
    // client version of the view model.
    //
    if (isCurrentModuleInstance(context, context.LocalViewModel.instanceId))
    {
        context.session.ModuleInstance.ServerViewModel = lodash.cloneDeep(context.LocalViewModel);
    }
    else
    {
        // Already navigated away before calling waitFor (local ViewModel not synchronized to other processors)
        //
        logger.info("waitFor - Navigated away from active instance before doing wait (local ViewModel will not be synchronized with other processors)");
        waitingOnCurrentInstance = false;
    }

    // We need to write the session even if we didn't update the ServerViewModel above, so any other session changes
    // will be properly synchronized with other processors (including, but not limited to, UserData).
    //
    this.sessionStore.putSession(context.session); // !!! Async, could temp fail

    var result = wait.for.apply(moduleObject, args);

    // Session data may have changed while we were yielding (that is the only time that can happen, given the single-
    // threaded nature of the environment).
    //
    // This UserData assignment/update logic below bears some explanation.  User code functions that receive a "session"
    // parameter are actually receiving context.session.UserData.  Those functions have a reference to this object,
    // which they typically refer to as "session".  It is imperitave that when we return from this method, the object
    // to which they have the reference is still the object to which context.session.UserData refers, otherwise local
    // changes to their "session" would be lost.  This is slightly complex, as we are reloading the session itself
    // below.
    //
    var originalUserDataObject = context.session.UserData;
    context.session = this.sessionStore.getSession(context.session.id); // !!! Async, could temp fail
    util.assignNewContents(originalUserDataObject, context.session.UserData);
    context.session.UserData = originalUserDataObject;

    // If we are still processing the current instance, get our local view model state back (note that it may have
    // been updated by another processor).
    //
    // Note: We don't have to check for the ServerViewModel, because if we are the current instance now, then we were
    //       also the current module instance before the wait, and would therefore have written the ServerViewModel to
    //       the session. The only way the ServerViewModel could be gone here is if another processor navigated away 
    //       from this instance while we were waiting, and in that case the isCurrentModuleInstance test below would fail.
    //
    if (isCurrentModuleInstance(context, context.LocalViewModel.instanceId))
    {
        // This is a little tricky.  The viewModel passed in to any processing function is actually stored in
        // context.LocalViewModel.ViewModel.  By updating the *contents* of that with the updated view model,
        // it will coincidentally (and magically) update the local viewModel parameter of the calling user-code
        // function (since it's the same object and we're just updating its contents).
        //
        // The magic part, which is potentially creepy, but also kind of cool and pretty much always the proper
        // behavior, is that you can call Synchro.waitFor passing the context in your user-code processing method
        // and your local viewModel will be updated (as appropriate) when it returns, even though you didn't pass
        // it in as a parameter to Synchro.waitFor or otherwise explicitly update it.
        //
        context.LocalViewModel.id = context.session.ModuleInstance.ServerViewModel.id;
        util.assignNewContents(context.LocalViewModel.ViewModel, lodash.cloneDeep(context.session.ModuleInstance.ServerViewModel.ViewModel));
    }
    else if (waitingOnCurrentInstance)
    {
        // Another processor navigated away during wait (local ViewModel not updated from other processors)
        //
        logger.info("waitFor - Another processor navigated away from active instance during wait (local ViewModel not updated from other processors)");
    }

    return result;
}

// Exposed via Synchro.interimUpdate()
//
SynchroApi.prototype.interimUpdate = function(context)
{
    logger.info("Interim update...");
    sendUpdate(this, context, true);
}

// Exposed via Synchro.isActiveInstance()
//
SynchroApi.prototype.isActiveInstance = function(context)
{
    return isCurrentModuleInstance(context, context.LocalViewModel.instanceId);
}

module.exports = SynchroApi;
