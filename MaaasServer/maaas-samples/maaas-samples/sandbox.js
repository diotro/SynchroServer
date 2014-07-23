﻿// Sandbox page
//
var userImage =  Synchro.getResourceUrl("user.png");
var profileImage = "http://fbcdn-profile-a.akamaihd.net/hprofile-ak-ash3/c23.23.285.285/s160x160/943786_10201215910308278_1343091684_n.jpg";

exports.View =
{
    title: "Sandbox",
    onBack: "exit",
    elements:
    [
        { control: "border", border: "White", borderthickness: "5", contents: [
            { control: "scrollview", orientation: "Horizontal", height: 150, width: 150, contents: [
                { control: "image", height: 300, width: 300, resource: "{image}" },
            ] },
        ] },

        { control: "canvas", height: 150, contents: [
            { control: "image", top: 0, left: 0, resource: "{image}" },
        ] },
        { control: "button", caption: "Switch images", binding: "switchImages" },
    ]
}

exports.InitializeViewModel = function(context, session)
{
    var viewModel =
    {
        image: profileImage,
    }
    return viewModel;
}

exports.Commands =
{
    switchImages: function(context, session, viewModel)
    {
        if (viewModel.image == userImage)
        {
            viewModel.image = profileImage;
        }
        else
        {
            viewModel.image = userImage;
        }
    },
    exit: function(context)
    {
        return Synchro.navigateToView(context, "menu");
    },
}
