﻿// Property Cross list page
//
exports.View =
{
    title: "Favorites",
    onBack: "exit",
    elements: 
    [
    ]
}

exports.InitializeViewModel = function(context, session)
{
    var viewModel =
    {
        count: 0,
    }
    return viewModel;
}

exports.Commands = 
{
    details: function(context, session, viewModel)
    {
    },
    exit: function(context)
    {
        return Maaas.navigateToView(context, "propx_main");
    },
}
