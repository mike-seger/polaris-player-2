/**
 * This file is intentionally "types-only" via JSDoc typedefs (no TS build needed).
 * Keep these stable: the UI/queue can depend on them, while adapters implement them.
 */

/**
 * @typedef {"idle"|"loading"|"ready"|"playing"|"paused"|"buffering"|"ended"|"error"} PlayerState
 */

/**
 * @typedef {Object} Capability
 * @property {boolean} canPlay
 * @property {boolean} canPause
 * @property {boolean} canStop
 * @property {boolean} canSeek
 * @property {boolean} canSetRate
 * @property {boolean} canSetVolume
 * @property {boolean} canMute
 * @property {boolean} hasAccurateTime
 * @property {boolean} hasAudioPipeline
 * @property {boolean} hasVideo
 */

/**
 * @typedef {Object} TimeInfo
 * @property {number} positionMs
 * @property {number|undefined} durationMs
 * @property {number|undefined} bufferedMs
 */

/**
 * @typedef {Object} PlaybackInfo
 * @property {PlayerState} state
 * @property {boolean} muted
 * @property {number} volume   // 0..1
 * @property {number} rate
 * @property {TimeInfo} time
 * @property {string|undefined} activeTrackId
 */

/**
 * @typedef {Object} PlayerError
 * @property {string} code
 * @property {string} message
 * @property {any=} detail
 */

/**
 * @typedef {Object} MediaPane
 * @property {"iframe"|"video"|"image"|"none"} kind
 * @property {HTMLElement=} element     // for iframe/video kinds
 * @property {string=} imageUrl         // for image kind
 * @property {string=} title
 * @property {string=} subtitle
 */

/**
 * @typedef {Object} TrackSourceFile
 * @property {"file"} kind
 * @property {string} url
 * @property {string=} mime
 *
 * @typedef {Object} TrackSourceYouTube
 * @property {"youtube"} kind
 * @property {string} videoId
 *
 * @typedef {Object} TrackSourceSpotify
 * @property {"spotify"} kind
 * @property {string} trackId
 *
 * @typedef {Object} TrackSourceVlc
 * @property {"vlc"} kind
 * @property {string} input
 *
 * @typedef {TrackSourceFile|TrackSourceYouTube|TrackSourceSpotify|TrackSourceVlc} TrackSource
 */

/**
 * @typedef {Object} Track
 * @property {string} id
 * @property {string=} title
 * @property {string=} artist
 * @property {number=} durationMs
 * @property {string=} artworkUrl
 * @property {TrackSource} source
 * @property {number=} startMs
 * @property {number=} endMs
 */

/**
 * @typedef {Object} AdapterLoadOptions
 * @property {boolean=} autoplay
 * @property {number=} startMs
 */

/**
 * @typedef {Object} IPlayerAdapter
 * @property {string} name
 * @property {(sourceKind: TrackSource["kind"]) => boolean} supports
 * @property {(container: HTMLElement) => void=} mount
 * @property {() => void=} unmount
 * @property {(track: Track) => (string|undefined)=} getThumbnailUrl
 * @property {() => Capability} getCapabilities
 * @property {(track: Track, opts?: AdapterLoadOptions) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(ms: number) => Promise<void>} seekToMs
 * @property {(v01: number) => Promise<void>} setVolume
 * @property {(m: boolean) => Promise<void>} setMuted
 * @property {(rate: number) => Promise<void>} setRate
 * @property {() => PlaybackInfo} getInfo
 * @property {(event: string, fn: Function) => (() => void)} on
 * @property {() => MediaPane} getMediaPane
 * @property {() => (Promise<void>|void)=} activate
 * @property {() => (Promise<void>|void)=} deactivate
 * @property {() => Promise<void>} dispose
 */

export {}; // ESM marker
