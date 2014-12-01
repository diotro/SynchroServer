// Field Engineer - Jon List page
//
var lodash = require("lodash");
var sql = require('mssql'); 

exports.View =
{
    title: "All Jobs",
    elements: 
    [
        { control: "stackpanel", width: "*", height: "*", contents: [

            { control: "stackpanel", orientation: "Horizontal", width: "*", visibility: "{isLoading}", contents: [
                { control: "progressring", value: "{isLoading}", height: 40, width: 40, verticalAlignment: "Center"},
                { control: "text", value: "Loading jobs...", width: "*", fontsize: 12, verticalAlignment: "Center"},
            ] },

            { control: "text", width: "*", value: "Here is your list of jobs", fontsize: 10, visibility: "{!isLoading}" },
            { control: "listview", select: "None", height: "*", width: "*", margin: { bottom: 0 }, binding: { items: "jobs", onItemClick: { command: "jobSelected", job: "{$data}" } }, 
                itemTemplate:
                    { control: "stackpanel", orientation: "Vertical", width: "*", padding: { left: 5 }, contents: [
                        { control: "stackpanel", orientation: "Vertical", width: "*", background: "{Color}", padding: { left: 5 }, contents: [
                            { control: "text", value: "Job Status: {Status}", font: { bold: true, size: 10 } },
                            { control: "stackpanel", orientation: "Horizontal", width: "*", padding: { left: 5 }, contents: [
                                { control: "text", value: "{JobNumber}", font: { bold: true, size: 10 } },
                                { control: "text", value: "{EtaTime}", fontsize: 10 },
                            ] },
                        ] },
                        { control: "text", value: "Customer: {FullName}", font: { bold: true, size: 10 } },
                        { control: "text", value: "Description:", font: { bold: true, size: 10 } },
                        { control: "text", value: "{Title}", fontsize: 10 },
                    ] },
            },

            { filter: { deviceMetric: "os", is: ["Windows", "WinPhone"] }, control: "commandBar.button", text: "Reload", icon: "Refresh", commandBar: "Bottom", binding: "reload" },
            { filter: { deviceMetric: "os", is: "Android" }, control: "actionBar.item", text: "Reload", showAsAction: "IfRoom", binding: "reload" },
            { filter: { deviceMetric: "os", is: "iOS" }, control: "navBar.button", systemItem: "Refresh", binding: "reload" },
        ] },
    ]
}

var agentId1 = '37e865e8-38f1-4e6b-a8ee-b404a188676e';
var agentId2 = '3c15184f-5b06-48cc-bcc8-55b6e621d9d0';

exports.InitializeViewModel = function(context, session, params, state)
{
    var viewModel =
    {
        jobs: null,
        isLoading: true
    }

    if (state)
    {
        // If we are coming back to the list page from a detail page, we restore the saved jobs list (to save us
        // from having to go get it again)
        //
        lodash.assign(viewModel, state);
        viewModel.isLoading = false;
    }

    return viewModel;
}

function connectDb(callback)
{
    var config = 
    {
        // This obviously should be moved to app config and out of source code...
        user: 'SynchroFieldEngineer@pr7sz1ussw',
        password: 'DataAccess1!',
        server: 'pr7sz1ussw.database.windows.net',
        database: 'FieldEngineer',
        options: 
        {
            encrypt: true // Use this if you're on Windows Azure
        }
    }

    var connection = new sql.Connection(config); 
    connection.connect(function(err)
    {
        callback(err, connection);
    });
}

function jobStatusToColor(status)
{
    if (status == "On Site") // InProgress
    {
        return "Green";
    }
    else if (status == "Not Started") // Pending
    {
        return "#D25A00" // 210, 90, 0
    }
    else if (status == "Completed") // Complete
    {
        return "LightBlue";
    }
}

function loadJobs(context, viewModel)
{
    try
    {
        var connection = Synchro.waitFor(context, connectDb);
        var request = connection.request();            
        recordset = Synchro.waitFor(context, request.query.bind(request), "select * from Job inner join Customer on Job.CustomerId=CUstomer.Id where AgentId='" + agentId1 + "'");
        viewModel.jobs = [];
        recordset.forEach(function(job)
        {
            // console.log("Job: " + JSON.stringify(job, null, 4));
            job.Color = jobStatusToColor(job.Status);
            viewModel.jobs.push(lodash.pick(job, "Status", "JobNumber", "EtaTime", "Title", "Status", "Color", "FullName", "HouseNumberOrName", "Street", "Town", "Postcode", "PrimaryContactNumber"));
        });
    }
    catch(err)
    {
        console.log("Error getting jobs: " + err);
    }    

    viewModel.isLoading = false;
}

exports.LoadViewModel = function(context, session, viewModel)
{
    // Only query for the jobs if we didn't already populated the list (from saved state) in InitViewModel above.
    //
    if (viewModel.jobs === null)
    {
        loadJobs(context, viewModel);
    }
}

exports.Commands = 
{
    reload: function(context, session, viewModel, params)
    {
        viewModel.isLoading = true;
        Synchro.interimUpdate(context);
        loadJobs(context, viewModel);
    },
    jobSelected: function(context, session, viewModel, params)
    {
        // Stash the job list in the session so we can pull it back it when we navigate back here.
        //
        var state = lodash.pick(viewModel, "jobs");
        return Synchro.pushAndNavigateTo(context, "fe_detail", { job: params.job }, state);
    },
}
