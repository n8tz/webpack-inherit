/*
 * The MIT License (MIT)
 * Copyright (c) 2019. Wise Wild Web
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 *  @author : Nathanael Braun
 *  @contact : n8tz.js@gmail.com
 */

const path                 = require('path'),
      is                   = require('is'),
      fs                   = require('fs'),
      resolve              = require('resolve'),
      utils                = require("./utils"),
      InjectPlugin         = require("webpack-inject-plugin").default,
      ENTRY_ORDER          = require("webpack-inject-plugin").ENTRY_ORDER,
      isBuiltinModule      = require('is-builtin-module'),
      VirtualModulesPlugin = require('webpack-virtual-modules');

module.exports = function ( cfg, opts ) {
	let plugin;
	
	// find da good webpack ( the one where the wp cfg is set )
	let wp               = resolve.sync('webpack', { basedir: path.dirname(opts.allWebpackCfg[0] || ".") }),
	    webpack          = require(wp),
	    ExternalModule   = require(path.join(path.dirname(wp), 'ExternalModule')),
	
	    projectPkg       = fs.existsSync(path.normalize(opts.allModuleRoots[0] + "/package.json")) &&
		    JSON.parse(fs.readFileSync(path.normalize(opts.allModuleRoots[0] + "/package.json"))),
	
	    excludeExternals = opts.vars.externals,
	    constDef         = opts.vars.DefinePluginCfg || {},
	    currentProfile   = process.env.__LPACK_PROFILE__ || 'default',
	    externalRE       = is.string(opts.vars.externals) && new RegExp(opts.vars.externals),
	    vMod             = new VirtualModulesPlugin();
	
	return plugin = {
		/**
		 * Return a sass resolver fn
		 * @param next {function} resolver that will be called if lPack fail resolving
		 *     the query
		 * @returns {function(*=, *=, *=): *}
		 */
		sassImporter: function ( next ) {
			return ( url, requireOrigin, cb ) =>
				plugin._sassImporter(url, requireOrigin, cb, next
				                                             ? e => next(url, requireOrigin, cb)
				                                             : null)
		},
		/**
		 * The main plugin fn
		 * @param compiler
		 */
		apply       : function ( compiler ) {
			let cache               = {},
			    plugin              = this,
			    RootAlias           = opts.vars.rootAlias || "App",
			    RootAliasRe         = new RegExp("^" + RootAlias, ''),
			    roots               = opts.allRoots,
			    contextDependencies = [],
			    fileDependencies    = [],
			    availableExts       = [],
			    activeGlobs         = { scss: {}, jsx: {} },
			    buildTarget         = compiler.options.target || "web",
			    useHotReload        = !!compiler.options.devServer,
			    startBuildTm        = Date.now();
			
			// Add some lPack build vars...
			compiler.options.plugins.push(vMod);
			compiler.options.plugins.push(
				new webpack.DefinePlugin(
					{
						'__LPACK_PROFILE__'  : currentProfile,
						'__WP_BUILD_TARGET__': buildTarget,
						...constDef
					}));
			
			// add the resolver plugin
			compiler.options.resolve         = compiler.options.resolve || {};
			compiler.options.resolve.plugins = compiler.options.resolve.plugins || [];
			compiler.options.resolve.plugins.push(
				{
					target: "resolve",
					source: "after-described-resolve",
					apply( resolver ) {
						const target = resolver.ensureHook(this.target);
						
						resolver
							.getHook(this.source)
							.tapAsync("lPackPlugin_" + currentProfile, ( request, resolveContext, callback ) => {
								//console.log("Resolve : ", request)
								lPackResolve(
									request,
									( err, req, data ) => {
										callback(err, req)
									},
									( err, req, data ) => {
										resolver.doResolve(
											target,
											req || request,
											"resolved lPack files using " + currentProfile, resolveContext,
											( err, result ) => {
												//console.log("Proxy resolved : ", err,
												// result)
												if ( err ) return callback(err);
												if ( result ) return callback(null, result);
												return callback();
											});
										
									})
							});
					}
				}
			)
			
			// include node modules path allowing node executables to require external
			// modules
			if ( /^(async-)?node$/.test(buildTarget) && excludeExternals ) {
				compiler.options.plugins.push(
					new InjectPlugin(function () {
						                 return "" +
							                 (
								                 is.string(compiler.options.devtool)
								                 && compiler.options.devtool.includes("source-map")
								                 ?
								                 "/** layer pack externals sourcemaps**/\n" +
									                 "require('source-map-support').install();\n"
								                 : ""
							                 ) +
							                 "/** layer pack externals modules loader **/\n" +
							                 fs.readFileSync(path.join(__dirname, '../etc/node/loadModulePaths_inject.js')) +
							                 `()(
    {
        allModulePath:${JSON.stringify(opts.allModulePath.map(p => path.normalize(path.relative(opts.projectRoot, p)).replace(/\\/g, '/')))},
        cDir:path.join(__non_webpack_require__.main.path,${JSON.stringify(path.normalize(path.relative(compiler.options.output.path, opts.projectRoot)).replace(/\\/g, '/'))})
    },
    ${JSON.stringify(path.relative(opts.projectRoot, compiler.options.output.path).replace(/\\/g, '/'))}
);`
					                 },
					                 ENTRY_ORDER.First)
				)
			}
			;
			
			
			// add resolve paths
			compiler.options.resolve = compiler.options.resolve || {};
			
			// requiered for $super resolving
			compiler.options.resolve.cacheWithContext = true;
			
			compiler.options.resolve.modules = compiler.options.resolve.modules || [];
			compiler.options.resolve.modules.unshift(...opts.allModulePath);
			compiler.options.resolveLoader         = compiler.options.resolveLoader || {};
			compiler.options.resolveLoader.modules = compiler.options.resolveLoader.modules || [];
			compiler.options.resolveLoader.modules.unshift(...opts.allModulePath);
			
			// detect resolvable ext
			if ( compiler.options.resolve.extensions ) {
				availableExts.push(...compiler.options.resolve.extensions);
			}
			else availableExts = ["", ".webpack.js", ".web.js", ".js"];
			availableExts = availableExts.filter(ext => ((ext != '.')));
			availableExts.push(...availableExts.filter(ext => ext).map(ext => ('/index' + ext)));
			availableExts.unshift('');
			
			/**
			 * The main resolver / glob mngr
			 */
			function lPackResolve( data, cb, proxy ) {
				let requireOrigin = data.context && data.context.issuer,
				    context       = requireOrigin && path.dirname(requireOrigin),
				    reqPath       = data.request || data.path,
				    tmpPath;
				
				// do not re resolve
				if ( data.lPackOriginRequest ) {
					return cb();
				}
				
				data.lPackOriginRequest = reqPath;
				
				if ( context && /^\./.test(reqPath) && (tmpPath = roots.find(r => path.resolve(context + '/' + reqPath).startsWith(r))) ) {
					reqPath = (RootAlias + path.resolve(context + '/' + reqPath).substr(tmpPath.length)).replace(/\\/g, '/');
				}
				
				let isSuper = /^\$super$/.test(reqPath),
				    isGlob  = reqPath.indexOf('*') != -1,
				    isRoot  = RootAliasRe.test(reqPath);
				
				// glob resolving...
				if ( isGlob ) {
					
					if ( /\.s?css$/.test(requireOrigin) )
						activeGlobs.scss[reqPath] = true;
					else
						activeGlobs.jsx[reqPath] = true;
					
					return (/\.s?css$/.test(requireOrigin)
					        ? utils.indexOfScss
					        : utils.indexOf)(
						vMod,
						compiler.inputFileSystem,
						roots,
						reqPath,
						contextDependencies,
						fileDependencies,
						RootAlias,
						RootAliasRe,
						useHotReload,
						function ( e, filePath, content ) {
							//console.warn("glob", filePath)
							let req = {
								...data,
								relativePath: undefined,
								path        : filePath,
								resource    : filePath,
								module      : false,
								file        : true,
								request     : filePath,
							};
							cb(e, req, content);
						}
					)
				}
				
				if ( !isRoot && !isSuper ) { // let wp deal with it
					return cb()
				}
				
				
				// $super resolving..
				if ( isSuper ) {
					return utils.findParent(
						compiler.inputFileSystem,
						roots,
						requireOrigin,
						[''],
						fileDependencies,
						function ( e, filePath, file ) {
							if ( e && !filePath ) {
								console.error("Parent not found \n'%s'",
								              requireOrigin);
								return cb(null, {
									...data,
									path: false// ignored
								});
							}
							cb(null, {
								...data,
								path        : filePath,
								relativePath: undefined,
								//request     : filePath,
								resource    : filePath,
								module      : false,
								file        : true
							});
						}
					);
				}
				
				// Inheritable root based resolving
				if ( isRoot ) {
					return utils.findParentPath(
						compiler.inputFileSystem,
						roots,
						reqPath.replace(RootAliasRe, ''),
						0,
						availableExts,
						fileDependencies,
						function ( e, filePath, file ) {
							if ( e ) {
								console.error("File not found \n'%s' (required in '%s')",
								              reqPath, requireOrigin);
								return cb()
							}
							//console.log("find %s\t\t\t=> %s", reqPath, filePath);
							let req = {
								...data,
								path        : filePath,
								relativePath: undefined,
								//request     : filePath,
								resource    : filePath
							};
							cb(null, req);
						}
					);
				}
				//console.error("wtf \n'%s' (required in '%s')",
				//              reqPath, requireOrigin);
			}
			
			// sass resolver
			this._sassImporter = function ( url, requireOrigin, cb, next ) {
				let tmpPath;
				if ( requireOrigin &&
					/^\./.test(url) &&
					(tmpPath = roots.find(r => path.resolve(path.dirname(requireOrigin) + '/' + url).startsWith(r))) ) {
					
					url = (RootAlias + path.resolve(path.dirname(requireOrigin) + '/' + url).substr(tmpPath.length)).replace(/\\/g, '/');
				}
				
				if ( RootAliasRe.test(url) || url[0] === '$' || url[0] === '.' ) {
					lPackResolve(
						{
							context: {
								issuer: requireOrigin
							},
							request: path.normalize(url)
						},
						( e, found, contents ) => {
							if ( found || contents ) {
								cb && cb(contents && { contents } || { file: found.resource || found.path });
							}
							else {
								next && next()
							}
							
						}
					)
				}
				else return cb(url, requireOrigin, cb);
			};
			
			// wp hook
			compiler.hooks.normalModuleFactory.tap("layer-pack",
			                                       function ( nmf ) {
				
				                                       utils.addVirtualFile(
					                                       vMod, compiler.inputFileSystem,
					                                       path.normalize(roots[0] + '/.buildInfos.json.js'),
					                                       `
module.exports=
            {
                project    : {
	                name       : ${JSON.stringify(projectPkg.name)},
	                description: ${JSON.stringify(projectPkg.description)},
	                author     : ${JSON.stringify(projectPkg.author)},
	                version    : ${JSON.stringify(projectPkg.version)}
                },
                buildDate  : ${startBuildTm},
                profile    : ${JSON.stringify(currentProfile)},
                ${/^(async-)?node$/.test(buildTarget) ? `
                projectRoot: require("path").join(__non_webpack_require__.main.path,${JSON.stringify(path.normalize(path.relative(compiler.options.output.path, opts.projectRoot)).replace(/\\/g, '/'))}),
                ` : ""}
                vars       : ${JSON.stringify(opts.vars)},
                allCfg     : ${JSON.stringify(opts.allCfg)},
                allModId   : ${JSON.stringify(opts.allModId)}
            };
						                `
				                                       );
				
				                                       utils.addVirtualFile(
					                                       vMod, compiler.inputFileSystem,
					                                       path.normalize(roots[0] + '/.___layerPackIndexUtils.js'),
					                                       fs.readFileSync(path.join(__dirname, '../etc/utils/indexUtils.js'))
				                                       );
				
				                                       if ( excludeExternals )
					                                       if ( nmf.hooks.resolve )// wp5
					                                       {
						                                       nmf.hooks.resolve.tap('layer-pack', function ( data, callback ) {
							                                       let requireOrigin = data.contextInfo.issuer,
							                                           context       = data.context || path.dirname(requireOrigin),
							                                           request       = data.request,
							                                           mkExt         = isBuiltinModule(data.request),
							                                           isInRoot;
							
							                                       if ( data.request === "$super" || !data.contextInfo.issuer )// entry points ?
								                                       return;
							
							                                       if ( !mkExt ) {
								                                       // is it external ? @todo
								                                       mkExt = !(
									                                       RootAliasRe.test(data.request) ||
									                                       context &&
									                                       /^\./.test(data.request)
									                                       ? (isInRoot = roots.find(r => path.resolve(context + '/' + data.request).startsWith(r)))
									                                       : (isInRoot = roots.find(r =>
										                                                                path.resolve(data.request).startsWith(r))));
							                                       }
							                                       if ( mkExt &&
								                                       (
									                                       !externalRE
									                                       || externalRE.test(request)
								                                       )
								                                       &&
								                                       !(!isInRoot && /^\./.test(data.request)) // so
							                                                                                    // it's
							                                                                                    // relative
							                                                                                    // to
							                                                                                    // an
							                                                                                    // internal
							                                       ) {
								                                       return new ExternalModule(
									                                       request,
									                                       opts.vars.externalMode || "commonjs"
								                                       );
								
							                                       }
							                                       else {
								                                       return;
							                                       }
							
						                                       });
					                                       }
					                                       else {
						                                       nmf.plugin('factory', function ( factory ) {
							                                       return function ( data, callback ) {
								                                       let requireOrigin = data.contextInfo.issuer,
								                                           context       = data.context || path.dirname(requireOrigin),
								                                           request       = data.request,
								                                           mkExt         = isBuiltinModule(data.request),
								                                           isInRoot;
								
								                                       if ( data.request === "$super" || !data.contextInfo.issuer )// entry points ?
									                                       return factory(data, callback);
								
								                                       if ( !mkExt ) {
									                                       //console.log(data, context, roots)
									                                       // is it external ? @todo
									                                       mkExt = !(
										                                       RootAliasRe.test(data.request) ||
										                                       context &&
										                                       /^\./.test(data.request)
										                                       ? (isInRoot = roots.find(r => path.resolve(context + '/' + data.request).startsWith(r)))
										                                       : (isInRoot = roots.find(r =>
											                                                                path.resolve(data.request).startsWith(r))));
								                                       }
								                                       if ( mkExt &&
									                                       (
										                                       !externalRE
										                                       || externalRE.test(request)
									                                       )
									                                       &&
									                                       !(!isInRoot && /^\./.test(data.request)) // so
								                                                                                    // it's
								                                                                                    // relative
								                                                                                    // to
								                                                                                    // an
								                                                                                    // internal
								                                       ) {
									                                       return callback(null, new ExternalModule(
										                                       request,
										                                       opts.vars.externalMode || "commonjs"
									                                       ));
									
								                                       }
								                                       else {
									                                       return factory(data, callback);
								                                       }
								
							                                       };
						                                       });
					                                       }
				                                       //nmf.plugin("rebuildModule", ( req, cb ) => {
				                                       //    console.log("rebuildModule", req.request);
				                                       //    cb();
				                                       //});
			                                       }
			);
			
			// do update the globs v files
			
			compiler.hooks.watchRun.tap('layer-pack', ( compilation ) => {
				//console.log(activeGlobs)
				// todo : the glob indexes files are auto deleted
				for ( let reqPath in activeGlobs.jsx )
					if ( activeGlobs.jsx.hasOwnProperty(reqPath) ) {
						utils.indexOf(
							vMod,
							compiler.inputFileSystem,
							roots,
							reqPath,
							contextDependencies,
							fileDependencies,
							RootAlias,
							RootAliasRe,
							function ( e, filePath, content ) {
							}
						)
					}
				
				for ( let reqPath in activeGlobs.scss )
					if ( activeGlobs.scss.hasOwnProperty(reqPath) ) {
						utils.indexOfScss(
							vMod,
							compiler.inputFileSystem,
							roots,
							reqPath,
							contextDependencies,
							fileDependencies,
							RootAlias,
							RootAliasRe,
							function ( e, filePath, content ) {
							}
						)
					}
			})
			// should deal with hot reload watched files & dirs
			compiler.hooks.afterEmit.tapAsync('layer-pack', ( compilation, cb ) => {
				compilation.fileDependencies    = compilation.fileDependencies || [];
				compilation.contextDependencies = compilation.contextDependencies || [];
				if ( compilation.fileDependencies.concat ) {
					// Add file dependencies if they're not already tracked
					fileDependencies.forEach(( file ) => {
						if ( compilation.fileDependencies.indexOf(file) == -1 ) {
							compilation.fileDependencies.push(file);
						}
					});
					
					// Add context dependencies if they're not already tracked
					contextDependencies.forEach(( context ) => {
						if ( compilation.contextDependencies.indexOf(context) == -1 ) {
							compilation.contextDependencies.push(context);
						}
					});
				}
				else {// webpack 4
					// Add file dependencies if they're not already tracked
					fileDependencies.forEach(( file ) => {
						compilation.fileDependencies.add(file);
					});
					// Add context dependencies if they're not already tracked
					contextDependencies.forEach(( context ) => {
						compilation.contextDependencies.add(context);
					});
				}
				cb();
				cache = {};
			});
		}
	}
}
		
