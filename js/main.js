/*
 * Kiosk v5.14.0
 * Copyright (C) 2017 M. P. Cook Limited Liability Co.  <support@cook.company>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

chrome.app.runtime.onLaunched.addListener(init);
chrome.app.runtime.onRestarted.addListener(init);

var directoryServer, adminServer, restartTimeout;

function init() {

  var win, basePath, socketInfo, data;
  var filesMap = {};

  /*
  LOG PERMISSION WARNINGS
  use to test manifest permissions changes
  DO NOT publish if new warnings are triggered. Prompt on existing
  installations would likely be a major issue.

  Current permission warnings are:
  -"Exchange data with any device on the local network or internet",
  -"Read folders that you open in the application"

  Should be commented out in production application.
  */
  /*chrome.management.getPermissionWarningsByManifest(
    JSON.stringify(chrome.runtime.getManifest()),
    function(warning){
      console.log("PERMISSION WARNINGS",warning);
    }
  );*/

  chrome.storage.local.get(null,function(data){
    if(('url' in data)){
      //setup has been completed

      // Sleepmode may not have been selected by user in setup because it
      // is a new config param, so assume the previous hard-coded value as
      // default.
      if (!data.sleepmode) {
        chrome.storage.local.set({'sleepmode': 'display'});
        data.sleepmode = 'display';
      }
      if (data.sleepmode == 'none') {
        chrome.power.releaseKeepAwake();
      } else {
        chrome.power.requestKeepAwake(data.sleepmode);
      }

      if(data.servelocaldirectory && data.servelocalhost && data.servelocalport){
        //serve files from local directory
        chrome.fileSystem.restoreEntry(data.servelocaldirectory,function(entry){
          //if we can't get the directory (removed drive possibly)
          //wait 15 seconds and reload the app
          if(!entry){
            restartTimeout = setTimeout(function(){
              chrome.runtime.sendMessage('reload');
            }, 15*1000);
            return
          }

          var host = data.servelocalhost;
          var port = data.servelocalport;
          startWebserverDirectoryEntry(host,port,entry);
        });
      }
      if(data.host && data.port){
        //make setup page available remotely via HTTP
        startWebserver(data.host,data.port,'www',data);
      }
      openWindow("windows/browser.html");
    }else{
      //need to run setup
      openWindow("windows/setup.html");
    }
  });

  chrome.runtime.onMessage.addListener(function(request,sender,sendResponse){
     if(request == "reload"){
       chrome.runtime.getPlatformInfo(function(p){
         if(p.os == "cros"){
           //we're on ChromeOS, so `reload()` will always work
           chrome.runtime.reload();
         }else{
           //we're OSX/Win/*nix so `reload()` may not work if Chrome is not
           // running the background. Simply close all windows and reset.
           if(directoryServer) directoryServer.stop();
           if(adminServer) adminServer.stop();
           var w = chrome.app.window.getAll();
           for(var i = 0; i < w.length; i++){
             w[i].close();
           }
           init();
         }
       });
     }
   });

  function openWindow(path){
    if(win) win.close();
    chrome.system.display.getInfo(function(d){
      chrome.app.window.create(path, {
        'frame': 'none',
        'id': 'browser',
        'state': 'fullscreen',
        'bounds':{
           'left':0,
           'top':0,
           'width':d[0].bounds.width,
           'height':d[0].bounds.height
        }
      },function(w){
        win = w;
        if(win){
          win.fullscreen();
          setTimeout(function(){
            if(win) win.fullscreen();
          },1000);
        }
      });
    });
  }

  function startWebserverDirectoryEntry(host,port,entry) {
    directoryServer = new WSC.WebApplication({host:host,
                                              port:port,
                                              renderIndex:true,
                                              optRenderIndex:true,
                                              entry:entry
                                             })
    directoryServer.start()
  }

  //directory must be a subdirectory of the package
  function startWebserver(host,port,directory,settings){
    chrome.runtime.getPackageDirectoryEntry(function(packageDirectory){
      packageDirectory.getDirectory(directory,{create: false},function(webroot){
        var fs = new WSC.FileSystem(webroot)
        var handlers = [['/data.*', AdminDataHandler],
                        ['.*', WSC.DirectoryEntryHandler.bind(null, fs)]]
        adminServer = new WSC.WebApplication({host:host,
                                              port:port,
                                              optAllInterfaces: true,
                                              handlers:handlers,
                                              renderIndex:true,
                                              optRenderIndex:true,
                                              auth:{ username: settings.username,
                                                     password: settings.password }
                                             })
        adminServer.start()
      });
    });
  }
}

function stopAutoRestart(){
  if(restartTimeout) {
    clearTimeout(restartTimeout);
  }
}

function AdminDataHandler(request) {
  WSC.BaseHandler.prototype.constructor.call(this)
}

var app = this;
_.extend(AdminDataHandler.prototype, {
  put: function() {
    //var newData = this.request.bodyparams
    var newData = JSON.parse(String.fromCharCode.apply(null, new Uint8Array(this.request.body)));

    chrome.storage.local.get(null, function(data) {

      var saveData = {}
      var restart = false;
      for(var key in newData){
        var value = newData[key];
        if(data.hasOwnProperty(key)){
          if(key == 'url' && !Array.isArray(value)){
            value = value.split(',');
            restart = true;
          }
          data[key] = value;
          saveData[key] = value;
        }
        if(key.toString() == "restart"){
          restart = true;
        }
      }
      chrome.storage.local.set(saveData);
      this.setHeader('content-type','text/json')
      var buf = new TextEncoder('utf-8').encode(JSON.stringify(data)).buffer
      this.write(buf)
      this.finish()

      if(restart) setTimeout( function() {
        chrome.runtime.getPlatformInfo(function(p){
      if(p.os == "cros"){
        //we're on ChromeOS, so `reload()` will always work
        chrome.runtime.reload();
      }else{
        //we're OSX/Win/*nix so `reload()` may not work if Chrome is not
        // running the background. Simply close all windows and reset.
        if(directoryServer) directoryServer.stop();
        if(adminServer) adminServer.stop();
        var w = chrome.app.window.getAll();
        for(var i = 0; i < w.length; i++){
          w[i].close();
        }
        init();
      }
    });
      }, 1000 )
                              
      
    }.bind(this))

  },
  get: function() {
    chrome.storage.local.get(null, function(data) {
      this.setHeader('content-type','text/json')
      var buf = new TextEncoder('utf-8').encode(JSON.stringify(data)).buffer
      this.write(buf)
      this.finish()
    }.bind(this))
  }
}, WSC.BaseHandler.prototype);