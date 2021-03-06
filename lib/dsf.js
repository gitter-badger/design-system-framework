///@TODO move dsf to models ?
var fs = require('fs'),
	path = require('path'),
	_ = require('lodash'),
	glob = require('glob'),
	Handlebars = require('handlebars'),
	watch = require('watch'),
	pathUtils = require('./utils/path.js'),
	funcUtils = require('./utils/function.js'),

	ComponentCandidate = require('../models/ComponentCandidate.js'),
	Component = require('../models/Component.js'),
	PreviewDocument = require('../models/PreviewDocument.js');

var defaultOptions = require('../options.json'),
	userOptions = {};

try{
	userOptions = require(pathUtils.absolutePath('options.json'));
}catch(err){
	userOptions = {};
}

var CONFIG = _.merge({}, defaultOptions, userOptions);


// state is mutable, CONFIG is not
var state = {
	componentsFetched: false,
	candidatesAdded: 0,
	candidatesResolved: 0,
	finishedResolveCandidates: function(){
		return this.candidatesAdded > 0 && this.candidatesAdded === this.candidatesResolved;
	}
};
var components = [],
	componentsById = {},
	waitingForComponentLoad = [],
	onRebuildCallback;





function fetchComponents(fromDir, config){
	if(!pathUtils.isDirectory(fromDir)){
		return;
	}
	var componentsDirs =  fs.readdirSync(fromDir);
	componentsDirs.forEach(function(dirName){

		var componentName = dirName;
		var componentDir = path.join(fromDir, componentName);

		addComponentPathCandidate(componentDir, null, config);
	});
}

/**
 * Add a condidate component path to be transformed into
 * a Component if it resolves
 * @param {string} path        relative path to component source
 * @param {string} componentId optional - componentId to use once resolved
 */
function addComponentPathCandidate(path, componentId, config){
	var candidate = new ComponentCandidate({
		dsf: API,
		path: path,
		id: componentId,
		config: config
	});
	state.candidatesAdded++;
	candidate.resolve(candidateResolved);
}

function candidateResolved(candidate){
	state.candidatesResolved++;

	if(candidate.isComponent){
		var component = new Component({
			path: candidate.path,
			dsf: API,
			id: candidate.options.id || removeAbsPath(candidate.absPath),
			config: candidate.config
		});
		if(CONFIG.base && CONFIG.base.css){
			component.baseDependencies = CONFIG.base.css.slice(0);
			if(CONFIG.base.css.indexOf(component.id)>-1){
				component.isBaseCss = true;
			}
		}
		components.push(component);
		componentsById[component.id] = component;
		component.build(componentLoaded.bind(null, component));

	}else{
		fetchComponents(candidate.path);
	}
}

function componentLoaded(component){
	waitingForComponentLoad.forEach(function(waitingFor){
		if(waitingFor.components[component.id]){
			// wait is over
			waitingFor.components[component.id] = false;
			waitingFor.count--;
			if(waitingFor.count === 0){
				waitingFor.callback();
			}
		}
	});
}

function removeAbsPath(absPath){
	var componentsPathAbs = pathUtils.absolutePath(CONFIG['components-path']);
	if(componentsPathAbs[componentsPathAbs.length-1]!=='/'){
		componentsPathAbs+='/';
	}
	return absPath.replace(componentsPathAbs, '');
}

function getComponents(){
	if(!state.finishedResolveCandidates()){
		return 'still fetching components';
	}
	return components;
}

function idFromFilePath(path){
	// remove left part
	path = removeAbsPath(pathUtils.absolutePath(path));

	// search for a component matching the beginning of the path
	var matches = _.filter(components, function(component){
		if(path.substr(0, component.id.length) === component.id){
			return true;
		}
		return false;
	});
	if(matches.length !== 1){
		throw new Error('file changed: ' + path + '; could not find a component');
	}
	return matches[0].id;
}

function watchFiles(){
	watch.watchTree(CONFIG['components-path'], function (f, curr, prev) {
		if (typeof f == "object" && prev === null && curr === null) {
			// Finished walking the tree
			console.log('watch: ready');
		} else if (prev === null) {
			// f is a new file

		} else if (curr.nlink === 0) {
			// f was removed

		} else {
			// f was changed
			var componentId = idFromFilePath(f);
			var component = API.getComponent(componentId);
			console.log('rebuilding... '+componentId);
			component.rebuild(function(){
				if(onRebuildCallback){
					onRebuildCallback(component);
					console.log(componentId+' rebuilt');
				}
			});

		}
	});
}





// define API
var API = {
	start: function(){

		// start fetching components from file system
		fetchComponents(CONFIG['components-path']);

		// add external components
		if(CONFIG['external-components']){
			_.each(CONFIG['external-components'], function(external, componentId){
				if(external['components-path']){
					fetchComponents(external['components-path'], external);
				}else if(external['component-path']){
					addComponentPathCandidate(external['component-path'], componentId, external);
				}

			});
		}

		// watch files
		watchFiles();

		// disable API.fetchComponents
		API.start = funcUtils.noop;
	},
	getOptions: function(){
		return CONFIG;
	},
	getComponents: funcUtils.logTime(getComponents),
	getComponent: function(componentId){
		return componentsById[componentId];
	},

	createPreviewDocument: function(){
		return new PreviewDocument();
	},
	getHandlebars: function(){
		return Handlebars;
	},

	whenLoaded: function(componentIds, callback){
		var missingCount = 0;
		var missing = _.reduce(componentIds, function(memo, componentId){
			if(typeof componentsById[componentId] === 'undefined'){
				memo[componentId] = true;
				missingCount++;
			}
			return memo;
		}, {});

		if(missingCount > 0){
			waitingForComponentLoad.push({
				callback: callback,
				components: missing,
				count: missingCount
			});

		}else{
			// all ready
			callback();
		}
	},

	onRebuild: function(callback){
		onRebuildCallback = callback;
	},

	getBaseCss: function(){
		var css = '';
		if(CONFIG.base && CONFIG.base.css){
			CONFIG.base.css.forEach(function(componentId){
				var component = API.getComponent(componentId);
				if(!component) throw new Error('argh');
				if(component){
					css += component.getCss();
				}
			});
		}
		return css;
	},

	getPreprocessor: function(name){
		return require('./preprocessors/'+name+'.js');
	}
};

// expose API
module.exports = API;
