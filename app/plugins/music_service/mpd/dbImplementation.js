var libQ = require('kew');
var path = require('path');
var url = require('url');
var Sequelize = require('sequelize');

// TODO: I think we can keep this module inside 'mpd' folder
var MusicLibrary = require('../music_library/index');
var utils = require('../music_library/lib/utils');

module.exports = DBImplementation;


/////////////////////////////

// TODO: move to config?
var ROOT = '/mnt';


var PLUGIN_NAME = 'music_library';


var PROTOCOL_LIBRARY = 'music-library';
var PROTOCOL_ARTISTS = 'artists';
var PROTOCOL_ALBUMS = 'albums';
var PROTOCOL_GENRES = 'genres';

/**
 * @class
 */
function DBImplementation(context) {

	// Save a reference to the parent commandRouter
	this.context = context;
	this.commandRouter = this.context.coreCommand;
	this.logger = this.context.logger;


	//initialization
	// this.albumArtPlugin = this.commandRouter.pluginManager.getPlugin('miscellanea', 'albumart');
	this.library = new MusicLibrary(context);
}


/**
 * @param {SearchQuery} query
 * @return {Promise<SearchResult[]>}
 * @implement plugin api
 */
DBImplementation.prototype.search = function(query) {
	var self = this;

	var uriInfo = DBImplementation.parseUri(query.uri);
	var protocol = uriInfo.protocol;

	self.logger.info('DBImplementation.search', query, protocol);
	console.time('DBImplementation.search');
	var searchValue = query.value;

	var isSearchTracks = !protocol || protocol == PROTOCOL_LIBRARY;
	var isSearchArtists = isSearchTracks || protocol == PROTOCOL_ARTISTS;
	var isSearchAlbums = isSearchTracks || protocol == PROTOCOL_ALBUMS;


	var titleCommon = self.commandRouter.getI18nString('COMMON.FOUND');
	var promiseResultArr = [];

	if (isSearchArtists) {
		promiseResultArr.push(this.searchArtists(searchValue).then(function(items) {
			var artistdesc = self.commandRouter.getI18nString(items.length > 1 ? 'COMMON.ARTISTS' : 'COMMON.ARTIST');
			return {
				'title': titleCommon + ' ' + items.length + ' ' + artistdesc + ' \'' + searchValue + '\'',
				'availableListViews': [
					'list', 'grid'
				],
				'items': items
			};
		}));
	}

	if (isSearchAlbums) {
		promiseResultArr.push(this.searchAlbums(searchValue).then(function(items) {
			var albumdesc = self.commandRouter.getI18nString(items.length > 1 ? 'COMMON.ALBUMS' : 'COMMON.ALBUM');
			return {
				'title': titleCommon + ' ' + items.length + ' ' + albumdesc + ' \'' + searchValue + '\'',
				'availableListViews': [
					'list', 'grid'
				],
				'items': items
			};
		}));
	}
	if (isSearchTracks) {
		promiseResultArr.push(this.searchTracks(searchValue).then(function(items) {
			var trackdesc = self.commandRouter.getI18nString(items.length > 1 ? 'COMMON.TRACKS' : 'COMMON.TRACK');
			return {
				'title': titleCommon + ' ' + items.length + ' ' + trackdesc + ' \'' + searchValue + '\'',
				'availableListViews': [
					'list'
				],
				'items': items
			};
		}));
	}

	return libQ.all(promiseResultArr).then(function(searchResultArr) {
		console.timeEnd('DBImplementation.search');
		return searchResultArr.filter(function(data) {
			return data.items.length > 0;
		});
	}).fail(function(e) {
		// TODO: caller doesn't log an error
		console.error(e);
		throw e;
	});
};


/**
 * @param {string} searchValue
 * @return {Promise<SearchResultItem[]>}
 */
DBImplementation.prototype.searchArtists = function(searchValue) {
	var self = this;
	return this.library.searchArtists({
		where: searchValue ? {
			artist: {[Sequelize.Op.substring]: searchValue}
		} : {
			artist: {[Sequelize.Op.not]: null}
		},
		order: ['artist'],
		raw: true
	}).then(function(artistsArr) {
		return artistsArr.map(function(artist) {
			return self.artist2SearchResult(artist);
		});
	});
};

/**
 * @param {string} searchValue
 * @return {Promise<SearchResultItem[]>}
 */
DBImplementation.prototype.searchAlbums = function(searchValue) {
	var self = this;
	return this.library.searchAlbums({
		where: searchValue ? {
			album: {[Sequelize.Op.substring]: searchValue}
		} : {
			album: {[Sequelize.Op.not]: null}
		},
		order: ['album']
	}).then(function(albumsArr) {
		return albumsArr.map(function(album) {
			return self.album2SearchResult(album);
		});
	});
};


/**
 * @param {string} searchValue
 * @return {Promise<SearchResultItem[]>}
 */
DBImplementation.prototype.searchTracks = function(searchValue) {
	var self = this;
	if(!searchValue){
		return libQ.reject(new Error('DBImplementation.searchTracks: search value is empty'));
	}

	return this.library.query({
		where: {
			[Sequelize.Op.or]: {
				title: {[Sequelize.Op.substring]: searchValue}
			}
		},
		order: ['tracknumber'],
		raw: true
	}).then(function(trackArr) {
		return trackArr.map(function(track) {
			return self.track2SearchResult(track);
		});
	});
};


/**
 *
 * Shall handle uris:
 * albums://
 * artitsts://
 * playlists://
 * genres://
 * mounts://<MOUNT_NAME>
 *
 * @param {string} uri
 * @param {string} [previousUri]
 * @return {!Promise<BrowseResult>}
 * @implement plugin api
 */
DBImplementation.prototype.handleBrowseUri = function(uri, previousUri) {
	var self = this;
	return libQ.resolve().then(function() {

		var uriInfo = DBImplementation.parseUri(uri);
		self.logger.info('DBImplementation.handleBrowseUri', uriInfo);

		var promise;
		switch (uriInfo.protocol) {
			case PROTOCOL_LIBRARY:
				promise = self.handleLibraryUri(uri);
				break;
			case PROTOCOL_ARTISTS:
				promise = self.handleArtistsUri(uri);
				break;
			case PROTOCOL_ALBUMS:
				promise = self.handleAlbumsUri(uri);
				break;
			case PROTOCOL_GENRES:
				promise = self.handleGenresUri(uri);
				break;
			default:
				promise = libQ.reject('Unknown protocol: ' + uriInfo.protocol);
		}
		return promise;
	}).fail(function(e) {
		// TODO: caller doesn't log the error
		console.error(e);
		throw e;
	});
};


/**
 * @param {string} uri
 * @return {Promise<BrowseResult>}
 */
DBImplementation.prototype.handleLibraryUri = function(uri) {
	var self = this;
	var uriInfo = DBImplementation.parseTrackUri(uri);

	return self.library.lsFolder(uriInfo.location).then(function(folderEntries) {
		var items = folderEntries.map(function(entry) {
			if (entry.type == 'file') {
				return self.track2SearchResult(entry.data);
			} else if (entry.type == 'folder') {
				return self.folder2SearchResult(entry.data);
			}
		});

		var isRoot = uriInfo.location == ROOT;
		return {
			navigation: {
				lists: [{
					availableListViews: [
						'list', 'grid'
					],
					items: items
				}],
				prev: {
					uri: isRoot ? '' : DBImplementation.getTrackUri({location: path.dirname(uriInfo.location)})
				}
			}
		};
	});
};


/**
 * @param {string} uri - //artistName/albumName
 * @return {Promise<BrowseResult>}
 */
DBImplementation.prototype.handleArtistsUri = function(uri) {
	var self = this;
	var uriInfo = DBImplementation.parseUri(uri);

	var info = null;
	var promise;
	if (uriInfo.parts.length === 0) {

		// list all artists
		promise = self.searchArtists();

	}
	if (uriInfo.parts.length === 1) {
		var artistName = uriInfo.parts[0];

		info = self.artistInfo(artistName);

		// list albums, which are belong to the artist
		promise = self.library.searchAlbums({
			where: {
				artist: {[Sequelize.Op.eq]: artistName},
			},
			order: ['disk', 'tracknumber', 'title'],
		}).then(function(albumArr) {
			return albumArr.map(function(album) {
				return self.album2SearchResult(album, PROTOCOL_ARTISTS);
			});
		});

	}
	if (uriInfo.parts.length === 2) {
		var artistName = uriInfo.parts[0];
		var albumName = uriInfo.parts[1];

		info = self.albumInfo(artistName, albumName);

		// list tracks, which are belong to the artist/album
		promise = self.library.query({
			where: {
				artist: {[Sequelize.Op.eq]: artistName},
				album: {[Sequelize.Op.eq]: albumName}
			},
			order: ['disk', 'tracknumber', 'title'],
			raw: true
		}).then(function(trackArr) {
			return trackArr.map(function(track) {
				return self.track2SearchResult(track);
			});
		});
	}

	return promise.then(function(items) {
		return {
			navigation: {
				lists: [{
					availableListViews: [
						'list', 'grid'
					],
					items: items
				}],
				prev: {
					uri: DBImplementation.getParentUri(uriInfo)
				},
				info: info
			}
		};

	});
};

/**
 * @param {string} uri
 * @return {Promise<BrowseResult>}
 */
DBImplementation.prototype.handleAlbumsUri = function(uri) {
	var self = this;
	var uriInfo = DBImplementation.parseUri(uri);
	var artistName = uriInfo.parts[0];
	var albumName = uriInfo.parts[1];

	var info = null;
	var promise;
	if (!albumName) {
		// list all albums
		promise = self.library.searchAlbums().then(function(albumArr) {
			return albumArr.map(function(album) {
				return self.album2SearchResult(album);
			});
		});
	} else {
		info = self.albumInfo(artistName, albumName);
		// list album tracks
		promise = self.library.query({
			where: {
				artist: {[Sequelize.Op.eq]: artistName},
				album: {[Sequelize.Op.eq]: albumName}
			},
			order: ['tracknumber'],
			raw: true
		}).then(function(trackArr) {
			return trackArr.map(function(track) {
				return self.track2SearchResult(track);
			});
		});
	}

	return promise.then(function(items) {
		return {
			navigation: {
				lists: [{
					availableListViews: [
						'list', 'grid'
					],
					items: items
				}],
				prev: {
					uri: albumName ? PROTOCOL_ALBUMS + '://' : ''
				},
				info: info
			}
		};

	});
};

/**
 * @param {string} uri
 * @return {Promise<BrowseResult>}
 *
 * @example uri:
 *   genres://Genre/Artist/
 */
DBImplementation.prototype.handleGenresUri = function(uri) {
	var self = this;
	var protocolParts = uri.split('://', 2);
	var genreComponents = decodeURIComponent(protocolParts[1]).split('/');
	var genreName = genreComponents[0];

	var promise;
	if (!genreName) {
		// list all albums
		promise = self.library.searchGenres().then(function(genresArr) {
			return genresArr.map(function(genre) {
				return self.genre2SearchResult(genre);
			});
		});
	} else {
		// list tracks by genre
		var orderBy = ['tracknumber'];
		promise = self.library.getByGenre(genreName, orderBy).then(function(trackArr) {
			return trackArr.map(function(track) {
				return self.track2SearchResult(track);
			});
		});
	}

	return promise.then(function(items) {
		return {
			navigation: {
				lists: [{
					availableListViews: [
						'list'
					],
					items: items
				}],
				prev: {
					uri: genreName ? PROTOCOL_GENRES + '://' : ''
				}
			}
		};

	});
};


/**
 * @param {string} uri
 * @return {Promise<TrackInfo>}
 * @implement plugin api
 */
DBImplementation.prototype.explodeUri = function(uri) {
	var self = this;
	return libQ.resolve().then(function() {

		var protocolParts = uri.split('://', 2);
		var protocol = protocolParts[0];
		self.logger.info('DBImplementation.explodeUri', uri, protocol);

		var promise;
		switch (protocol) {
			case PROTOCOL_LIBRARY:
				promise = self.explodeLibraryUri(uri);
				break;
			case PROTOCOL_ARTISTS:
				promise = self.explodeArtistsUri(uri);
				break;
			case PROTOCOL_ALBUMS:
				promise = self.explodeAlbumsUri(uri);
				break;

			default:
				promise = libQ.reject('Unknown protocol: ' + protocol);
		}

		return promise;
	}).fail(function(e) {
		// TODO: caller doesn't log the error
		console.error(e);
		throw e;
	});
};


/**
 * @param {string} uri
 * @return {Promise<TrackInfo>}
 */
DBImplementation.prototype.explodeLibraryUri = function(uri) {
	var self = this;

	var protocolParts = uri.split('://', 2);
	var protocol = protocolParts[0];
	self.logger.info('DBImplementation.explodeLibraryUri', uri, protocol);

	var trackInfo = DBImplementation.parseTrackUri(uri);
	return this.library.getTrack(trackInfo.location, trackInfo.trackOffset).then(function(track) {
		return [self.track2mpd(track)];
	});
};


/**
 * @param {string} uri
 * @return {Promise<TrackInfo>}
 */
DBImplementation.prototype.explodeArtistsUri = function(uri) {
	var self = this;

	var uriInfo = DBImplementation.parseUri(uri);

	var promise;
	if (uriInfo.parts.length >= 2) {
		promise = this.library.query({
			where: {
				artist: {[Sequelize.Op.eq]: uriInfo.parts[0]},
				album: {[Sequelize.Op.eq]: uriInfo.parts[1]}
			},
			order: ['disk', 'tracknumber', 'title'],
			raw: true
		});
	} else if (uriInfo.parts.length == 1) {
		promise = this.library.query({
			where: {
				artist: {[Sequelize.Op.eq]: uriInfo.parts[0]},
			},
			order: ['disk', 'tracknumber', 'title'],
			raw: true
		});
	} else {
		return libQ.reject('DBImplementation.explodeArtistsUri: empty uri');
	}
	return promise.then(function(tracks) {
		return tracks.map(self.track2mpd.bind(self));
	});

};


/**
 * @param {string} uri
 * @return {Promise<TrackInfo>}
 */
DBImplementation.prototype.explodeAlbumsUri = function(uri) {
	var self = this;

	var protocolParts = uri.split('://', 2);
	var albumName = decodeURIComponent(protocolParts[1]);
	return this.library.query({
		where: {
			album: {[Sequelize.Op.eq]: albumName}
		},
		order: ['disk', 'tracknumber', 'title'],
		raw: true
	}).then(function(tracks) {
		return tracks.map(self.track2mpd.bind(self));
	});

};


/**
 * @param {string} [uri]
 * @return {void}
 * @implement
 */
DBImplementation.prototype.updateDb = function(uri) {
	uri = uri || (PROTOCOL_LIBRARY + '://');
	var info = DBImplementation.parseTrackUri(uri);
	this.logger.info('DBImplementation.updateDb', info.location);

	this.library.update(info.location);
};


/**
 * @param {{artist: string, album?:string, size?:string}} data
 * @param {string} path  path to album art folder to scan
 * @param {string} icon  icon to show
 * @return {string}
 * @private
 *

 // track
 albumart = self.getAlbumArt({artist: artist, album: album}, self.getParentFolder('/mnt/' + path),'fa-tags');

 // artist
 albumart = self.getAlbumArt({artist: artist},undefined,'users');
 */
DBImplementation.prototype.getAlbumArt = function(data, path, icon) {
	if (this.albumArtPlugin == undefined) {
		//initialization, skipped from second call
		this.albumArtPlugin = this.commandRouter.pluginManager.getPlugin('miscellanea', 'albumart');
	}

	if (this.albumArtPlugin)
		return this.albumArtPlugin.getAlbumArt(data, path, icon);
	else {
		return '/albumart';
	}
};


/**
 * @param {AudioMetadata} record
 * @return {SearchResultItem}
 * @private
 */
DBImplementation.prototype.track2SearchResult = function(record) {
	var self = this;
	return {
		service: 'mpd',
		// service: PLUGIN_NAME,
		type: 'song',
		title: record.title || '',
		artist: record.artist || '',
		album: record.album || '',
		albumart: self.getAlbumArt({
			artist: record.artist,
			album: record.album
		}, path.dirname(record.location), 'fa-tags'),
		icon: 'fa fa-music',
		uri: DBImplementation.getTrackUri(record)
	};
};


/**
 * Technically, plays track
 * @param {AudioMetadata} record
 * @return {MPDTrack}
 * @private
 */
DBImplementation.prototype.track2mpd = function(record) {
	var self = this;
	return {
		service: 'mpd',
		name: record.title,
		artist: record.artist,
		album: record.album,
		type: 'track',
		tracknumber: record.tracknumber,
		albumart: self.getAlbumArt({
			artist: record.artist,
			album: record.album
		}, path.dirname(record.location), 'fa-music'),
		duration: record.format.duration,
		samplerate: record.samplerate,
		bitdepth: record.format.bitdepth,
		trackType: path.extname(record.location),
		uri: record.location.substr(1), // mpd expects absolute path without first '/'
	};
};


/**
 * @param {string} artistName
 * @return {SearchResultItem}
 * @private
 */
DBImplementation.prototype.artist2SearchResult = function(artistName) {
	var self = this;
	return {
		service: 'mpd',
		// service: PLUGIN_NAME,
		type: 'folder',
		title: artistName,
		albumart: self.getAlbumArt({artist: artistName}, undefined, 'users'),
		uri: PROTOCOL_ARTISTS + '://' + encodeURIComponent(artistName)
	};
};

/**
 * @param {Album} album
 * @param {string} [protocol]
 * @return {SearchResultItem}
 * @private
 */
DBImplementation.prototype.album2SearchResult = function(album, protocol) {
	var self = this;
	return {
		service: 'mpd',
		// service: PLUGIN_NAME,
		type: 'folder',
		title: album.album,
		albumart: self.getAlbumArt({artist: album.artist, album: album.album}, undefined, 'fa-tags'),
		uri: (protocol || PROTOCOL_ALBUMS) + '://' + encodeURIComponent(album.artist) + '/' + encodeURIComponent(album.album)
	};
};


/**
 * @param {string} genreName
 * @return {SearchResultItem}
 * @private
 */
DBImplementation.prototype.genre2SearchResult = function(genreName) {
	var self = this;
	return {
		service: PLUGIN_NAME,
		type: 'folder',
		title: genreName,
		albumart: self.getAlbumArt({}, undefined, 'fa-tags'),
		uri: PROTOCOL_GENRES + '://' + encodeURIComponent(genreName)
	};
};


/**
 * @param {string} location
 * @return {SearchResultItem}
 * @private
 */
DBImplementation.prototype.folder2SearchResult = function(location) {
	var self = this;
	var sourceTyped = {
		'USB': {
			dirtype: 'remdisk',
			diricon: 'fa fa-usb'
		},
		'INTERNAL': {
			dirtype: 'internal-folder',
		},
		'NAS': {
			dirtype: 'folder',
			diricon: 'fa fa-folder-open-o'
		},
		default: {
			dirtype: 'folder',
			diricon: 'fa fa-folder-open-o'
		}
	};

	// '/mnt/USB/folder1/folder2/..' to 'USB/folder1/folder2/..'
	var relativeFolder = path.relative(ROOT, location);

	var albumart;
	switch (relativeFolder) {
		case 'USB':
			albumart = self.getAlbumArt('', '', 'usb');
			break;
		case 'INTERNAL':
			albumart = self.getAlbumArt('', '', 'microchip');
			break;
		case 'NAS':
			albumart = self.getAlbumArt('', '', 'server');
			break;
		default:
			// any nested folder goes here (for example: 'INTERNAL/music')
			albumart = self.getAlbumArt('', location, 'folder-o');
	}

	return {
		service: PLUGIN_NAME,
		type: (sourceTyped[relativeFolder] || sourceTyped['default']).dirtype,
		// icon: (sourceTyped[relativeFolder] || sourceTyped['default']).diricon,
		title: path.basename(location),
		albumart: albumart,
		uri: DBImplementation.getTrackUri({location: location})
	};
};

//
// if (uri === 'music-library') {
// 	switch(path) {
// 		case 'INTERNAL':
// 			var albumart = self.getAlbumArt('', '','microchip');
// 			break;
// 		case 'NAS':
// 			var albumart = self.getAlbumArt('', '','server');
// 			break;
// 		case 'USB':
// 			var albumart = self.getAlbumArt('', '','usb');
// 			break;
// 		default:
// 			var albumart = self.getAlbumArt('', '/mnt/' + path,'folder-o');
// 	}
// } else {
// 	var albumart = self.getAlbumArt('', '/mnt/' + path,'folder-o');
// }


/**
 * @param {string} artistName
 * @return {BrowseResultInfo}
 * @private
 */
DBImplementation.prototype.artistInfo = function(artistName) {
	var self = this;
	return {
		service: 'mpd',
		type: 'artist',
		title: artistName,
		albumart: self.getAlbumArt({artist: artistName}, undefined, 'users'),
		uri: PROTOCOL_ARTISTS + '://' + encodeURIComponent(artistName)
	};
};


/**
 * @param {string} artistName
 * @param {string} albumName
 * @return {BrowseResultInfo}
 * @private
 */
DBImplementation.prototype.albumInfo = function(artistName, albumName) {
	var self = this;
	return {
		service: 'mpd',
		type: 'album',
		title: albumName,
		albumart: self.getAlbumArt({artist: artistName, album: albumName}, undefined, 'fa-tags'),
		uri: PROTOCOL_ARTISTS + '://' + encodeURIComponent(artistName) + '/' + encodeURIComponent(albumName)
	};
};


/**
 * Get track uri
 * @param {{location:string, trackOffset?:number}} track
 * @return {string}
 * @private
 * @static
 */
DBImplementation.getTrackUri = function(track) {
	var params = (track.trackOffset !== null && track.trackOffset !== undefined) ? 'trackoffset=' + track.trackOffset : null;
	return track.location.replace(ROOT, PROTOCOL_LIBRARY + '://') + (params ? '?' + params : '');
};

/**
 * Parse track uri
 *
 * Note: the following uri are valid:
 *  1. 'root' url: 'music-library'
 *  2. non-'root' url: 'music-library://USB/some/folder'
 * @param {string} uri
 * @return {{protocol:string, location:string, trackOffset:number}} - primary key for AudioMetadata
 * @static
 */
DBImplementation.parseTrackUri = function(uri) {
	var protocolParts = uri.split('://', 2);
	var protocol = protocolParts[0];

	var queryParts = (protocolParts[1] || '').split('?', 2);
	var location = protocol == PROTOCOL_LIBRARY ? path.join(ROOT, queryParts[0] || '') : queryParts[0] || '';

	var params = utils.parseQueryParams(queryParts[1] || '');
	return {
		protocol: protocol,
		location: location,
		trackOffset: params.trackoffset
	};
};


/**
 * @param {{protocol:string, parts:Array<string>}} uriInfo
 * @return {string}
 * @static
 */
DBImplementation.getParentUri = function(uriInfo) {
	if (uriInfo.parts.length == 0) {
		return '';
	}
	var allButLast = uriInfo.parts.slice(0, uriInfo.parts.length - 1);
	return PROTOCOL_ARTISTS + '://' + allButLast.join('/');
};

/**
 * Parse artist uri
 * @param {string} uri
 * @return {{protocol:string, parts:Array<string>}}
 * @static
 */
DBImplementation.parseUri = function(uri) {

	// fix: uri should always ends with '://'
	if (uri.indexOf('://') < 0) {
		uri += '://';
	}

	var protocolParts = uri.split('://', 2);
	var protocol = protocolParts[0];
	var parts = ((protocolParts[1] || '').split('/') || []).map(function(part) {
		return part ? decodeURIComponent(part) : undefined;
	}).filter(function(part) {
		return !!part;
	});

	return {
		protocol: protocol,
		parts: parts
	};
};