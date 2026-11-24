// Copyright (c) 2020-2026 by Juliusz Chroboczek.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

/**
 * @typedef {Object} filterDefinition
 * @property {string} [description]
 * @property {boolean} [protectBackground]
 * @property {(this: filterDefinition) => Promise<boolean>} [predicate]
 * @property {(this: Filter) => Promise<void>} [init]
 * @property {(this: Filter) => Promise<void>} [cleanup]
 * @property {(this: Filter, src: HTMLVideoElement, ctx: CanvasRenderingContext2D) => Promise<boolean>} draw
 */

/**
 * @param {MediaStream} stream
 * @param {filterDefinition} definition
 * @constructor
 */
function Filter(stream, definition) {
    /** @ts-ignore */
    if(!HTMLCanvasElement.prototype.captureStream) {
        throw new Error('Filters are not supported on this platform');
    }

    /** @type {MediaStream} */
    this.inputStream = stream;
    /** @type {filterDefinition} */
    this.definition = definition;
    /** @type {number} */
    this.frameRate = 30;
    /** @type {HTMLVideoElement} */
    this.video = document.createElement('video');
    /** @type {HTMLCanvasElement} */
    this.canvas = document.createElement('canvas');
    /** @type {CanvasRenderingContext2D} */
    this.context = this.canvas.getContext('2d');
    /** @type {MediaStream} */
    this.outputStream = null;
    /** @type {number} */
    this.timer = null;
    /** @type {number} */
    this.count = 0;
    /** @type {boolean} */
    this.fixedFramerate = false;
    /** @type {Record<string,any>} */
    this.userdata = {}
    /** @type {MediaStream} */
    this.captureStream = this.canvas.captureStream(0);
    /** @type {boolean} */
    this.busy = false;
}

Filter.prototype.start = async function() {
    /** @ts-ignore */
    if(!this.captureStream.getTracks()[0].requestFrame) {
        console.warn('captureFrame not supported, using fixed framerate');
        /** @ts-ignore */
        this.captureStream = this.canvas.captureStream(this.frameRate);
        this.fixedFramerate = true;
    }

    this.outputStream = new MediaStream();
    this.outputStream.addTrack(this.captureStream.getTracks()[0]);
    this.inputStream.getTracks().forEach(t => {
        t.onended = e => this.stop();
        if(t.kind !== 'video')
            this.outputStream.addTrack(t);
    });
    this.video.srcObject = this.inputStream;
    this.video.muted = true;
    this.video.play().catch(() => {});
    try {
        if(this.definition.init)
            await this.definition.init.call(this);
    } catch(e) {
        this.captureStream.getTracks()[0].stop();
        this.video.srcObject = null;
        if(this.definition.cleanup)
            await this.definition.cleanup.call(this);
        throw e;
    }
    this.timer = setInterval(() => this.draw(), 1000 / this.frameRate);
}

Filter.prototype.draw = async function() {
    if(this.video.videoWidth === 0 && this.video.videoHeight === 0) {
        // video not started yet
        return;
    }

    // check framerate every 30 frames
    if((this.count % 30) === 0) {
        let frameRate = 0;
        this.inputStream.getTracks().forEach(t => {
            if(t.kind === 'video') {
                let r = t.getSettings().frameRate;
                if(r)
                    frameRate = r;
            }
        });
        if(frameRate && frameRate !== this.frameRate) {
            clearInterval(this.timer);
            this.frameRate = frameRate;
            this.timer = setInterval(() => this.draw(), 1000 / this.frameRate);
        }
    }

    if(this.busy) {
        // drop frame
        return;
    }

    try {
        this.busy = true;
        let ok = false;
        try {
            ok = await this.definition.draw.call(
                this, this.video, this.context,
            );
        } catch(e) {
            console.error(e);
        }
        if(ok && !this.fixedFramerate) {
            /** @ts-ignore */
            this.captureStream.getTracks()[0].requestFrame();
        }
        this.count++;
    } finally {
        this.busy = false;
    }
};

Filter.prototype.stop = async function() {
    if(!this.timer)
        return;
    this.captureStream.getTracks()[0].stop();
    clearInterval(this.timer);
    this.timer = null;
    this.video.srcObject = null;
    if(this.definition.cleanup)
        await this.definition.cleanup.call(this);
};

/**
 * Removes any filter set on c.
 *
 * @param {Stream} c
 */
async function removeFilter(c) {
    let old = c.userdata.filter;
    if(!old)
        return;

    if(!(old instanceof Filter))
        throw new Error('userdata.filter is not a filter');

    c.setStream(old.inputStream);
    await old.stop();
    c.userdata.filter = null;
}

/**
 * Sets the filter described by c.userdata.filterDefinition on c.
 *
 * @param {Stream} c
 */
async function setFilter(c) {
    await removeFilter(c);

    if(!c.userdata.filterDefinition)
        return;

    let filter = new Filter(c.stream, c.userdata.filterDefinition);
    await filter.start();
    if(!c.sc) {
        await filter.stop();
        return;
    }
    c.setStream(filter.outputStream);
    c.userdata.filter = filter;
}

/**
 * Sends a message to a worker, then waits for a reply.
 *
 * @param {Worker} worker
 * @param {any} message
 * @param {Transferable[]} [transfer]
 */
async function workerSendReceive(worker, message, transfer) {
    if(worker.onmessage)
        throw new Error("worker busy");
    let timer;
    let p = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Background worker timed out')), 15000);
        worker.onerror = e => reject(new Error(e.message || 'Background worker unavailable'));
        worker.onmessage = e => {
            if(e && e.data) {
                if(e.data instanceof Error)
                    reject(e.data);
                else
                    resolve(e.data);
            } else {
                resolve(null);
            }
        };
    });
    try {
        worker.postMessage(message, transfer);
        return await p
    } finally {
        clearTimeout(timer);
        worker.onerror = null;
        worker.onmessage = null;
    }
}

/**
 * @typedef {Object} BackgroundImage
 * @property {(timestamp: number) => ImageBitmap|HTMLCanvasElement|HTMLVideoElement} frame
 * @property {() => void} [close]
 * @property {() => Promise<void>} [play]
 */

// Keep the chosen image in this tab only.
/** @type {BackgroundImage | null} */
let backgroundImage = null;
/** @type {Promise<boolean> | null} */
let backgroundSupport = null;

function canSegmentBackground() {
    if(backgroundSupport)
        return backgroundSupport;

    if(typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' ||
       typeof createImageBitmap !== 'function' || !HTMLCanvasElement.prototype.captureStream) {
        backgroundSupport = Promise.resolve(false);
        return backgroundSupport;
    }

    let context = new OffscreenCanvas(1, 1).getContext('webgl2');
    if(!context) {
        backgroundSupport = Promise.resolve(false);
        return backgroundSupport;
    }
    context.getExtension('WEBGL_lose_context')?.loseContext();

    backgroundSupport = fetch('/third-party/tasks-vision/vision_bundle.mjs', {
        method: 'HEAD',
    }).then(r => r.ok).catch(e => {
        console.warn('Background effects are unavailable:', e);
        return false;
    });
    return backgroundSupport;
}

/**
 * @param {File} file
 * @returns {Promise<BackgroundImage>}
 */
async function decodeBackgroundImage(file) {
    let mime = file.type.split(';', 1)[0].trim().toLowerCase();
    if(mime === 'video/webm' || mime === 'audio/webm' || /\.webm$/i.test(file.name)) {
        if(file.size > 30 * 1024 * 1024)
            throw new Error('Choisis une vidéo WebM de 30 Mio maximum.');
        return await decodeBackgroundVideo(file);
    }
    if(!/^image\/(png|jpeg|webp|gif)$/.test(mime) ||
       file.size > 10 * 1024 * 1024) {
        throw new Error('Choisis une image PNG, JPEG, WebP ou GIF de 10 Mio maximum, ou une vidéo WebM.');
    }

    if(mime === 'image/gif') {
        let {loadGifBackground} = await import('./animated-background.mjs');
        return loadGifBackground(await file.arrayBuffer());
    }

    let image = await createImageBitmap(file);
    let maxDimension = Math.max(image.width, image.height);
    if(maxDimension > 1920) {
        let original = image;
        let scale = 1920 / maxDimension;
        try {
            image = await createImageBitmap(original, {
                resizeWidth: Math.max(1, Math.round(original.width * scale)),
                resizeHeight: Math.max(1, Math.round(original.height * scale)),
                resizeQuality: 'high',
            });
        } finally {
            original.close();
        }
    }

    return {
        frame: () => image,
        close: () => image.close(),
    };
}

/** @param {File} file @returns {Promise<BackgroundImage>} */
async function decodeBackgroundVideo(file) {
    let signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if(signature[0] !== 0x1a || signature[1] !== 0x45 ||
       signature[2] !== 0xdf || signature[3] !== 0xa3)
        throw new Error('Ce fichier n’est pas un WebM valide.');

    let video = document.createElement('video');
    video.defaultMuted = true;
    video.muted = true;
    video.playsInline = true;
    video.loop = true;
    video.preload = 'auto';
    let url = URL.createObjectURL(file.slice(0, file.size, 'video/webm'));
    let idleTimer;
    let loadTimer;
    let autoPlay = true;
    /** @type {Promise<void>|null} */
    let playback = null;
    function close() {
        autoPlay = false;
        clearTimeout(idleTimer);
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
    try {
        await new Promise((resolve, reject) => {
            video.onloadeddata = () => resolve(null);
            video.onerror = () => reject(new Error(
                video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ?
                    'Ce navigateur ne reconnaît pas le codec de ce fichier WebM.' :
                    'Le navigateur n’a pas pu décoder la vidéo WebM.',
            ));
            loadTimer = setTimeout(() => reject(new Error(
                'Le navigateur n’a pas fourni de première image du WebM.',
            )), 12000);
            video.src = url;
        });
        if(!video.videoWidth || !video.videoHeight)
            throw new Error('Ce fichier WebM ne contient pas de piste vidéo.');
    } catch(e) {
        video.onloadeddata = video.onerror = null;
        close();
        throw e;
    } finally {
        video.onloadeddata = video.onerror = null;
        clearTimeout(loadTimer);
    }

    function play() {
        if(!playback) {
            playback = video.play().then(() => {
                playback = null;
            }, e => {
                playback = null;
                autoPlay = false;
                throw e;
            });
        }
        return playback;
    }
    return {
        frame: () => {
            if(video.paused && autoPlay && !playback)
                play().catch(() => {});
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => video.pause(), 1000);
            return video;
        },
        play: () => {
            autoPlay = true;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => video.pause(), 1000);
            return play();
        },
        close: close,
    };
}

/** @param {BackgroundImage | null} image */
function setBackgroundImage(image) {
    backgroundImage?.close?.();
    backgroundImage = image;
}

/**
 * @param {string} description
 * @param {'blur'|'image'|'solid'} mode
 * @returns {filterDefinition}
 */
function createBackgroundFilter(description, mode) {
    return {
        description: description,
        predicate: mode === 'image' ? canSegmentBackground : undefined,
        protectBackground: true,
        init: async function() {
            if(!(this instanceof Filter))
                throw new Error('Bad type for this');
            if(!await canSegmentBackground()) {
                displayWarning('Flou indisponible dans ce navigateur. L’image est masquée.');
                return;
            }
            try {
                this.userdata.worker = new Worker('/background-blur-worker.js');
                await workerSendReceive(this.userdata.worker, {
                    model: '/third-party/tasks-vision/models/selfie_segmenter.tflite',
                });
            } catch(e) {
                this.userdata.worker?.terminate();
                this.userdata.worker = null;
                console.warn('Background effect unavailable:', e);
                displayWarning('Effet vidéo indisponible. L’image est masquée.');
            }
        },
        cleanup: async function() {
            let worker = this.userdata.worker;
            if(!worker)
                return;
            if(worker.onmessage)
                worker.onmessage(null);
            worker.terminate();
            this.userdata.worker = null;
        },
        draw: async function(src, ctx) {
            const width = src.videoWidth;
            const height = src.videoHeight;
            if(ctx.canvas.width !== width || ctx.canvas.height !== height) {
                ctx.canvas.width = width;
                ctx.canvas.height = height;
            }

            let bitmap;
            let mask;
            try {
                if(this.userdata.worker) {
                    bitmap = await createImageBitmap(src);
                    const result = await workerSendReceive(this.userdata.worker, {
                        bitmap: bitmap,
                        timestamp: performance.now(),
                    }, [bitmap]);
                    if(!result)
                        return false;
                    bitmap = result.bitmap;
                    mask = result.mask;

                    const image = mode === 'image' ? backgroundImage?.frame(performance.now()) : null;
                    const imageWidth = image instanceof HTMLVideoElement ? image.videoWidth : image?.width;
                    const imageHeight = image instanceof HTMLVideoElement ? image.videoHeight : image?.height;

                    ctx.globalCompositeOperation = 'copy';
                    ctx.drawImage(mask, 0, 0);
                    ctx.globalCompositeOperation = 'source-out';
                    ctx.drawImage(bitmap, 0, 0);
                    ctx.globalCompositeOperation = 'destination-over';

                    if(imageWidth && imageHeight &&
                       (!(image instanceof HTMLVideoElement) || (!image.error && image.readyState >= 2))) {
                        const scale = Math.max(width / imageWidth, height / imageHeight);
                        const dw = imageWidth * scale;
                        const dh = imageHeight * scale;
                        ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
                    } else if(mode !== 'solid') {
                        // Discard fine detail before upscaling. An opaque
                        // blurred layer covers all of the area outside the mask.
                        if(!this.userdata.blurCanvas)
                            this.userdata.blurCanvas = document.createElement('canvas');
                        const small = /** @type {HTMLCanvasElement} */ (this.userdata.blurCanvas);
                        const scale = 16 / Math.max(width, height);
                        const sw = Math.max(1, Math.round(width * scale));
                        const sh = Math.max(1, Math.round(height * scale));
                        if(small.width !== sw || small.height !== sh) {
                            small.width = sw;
                            small.height = sh;
                        }
                        const blur = small.getContext('2d');
                        blur.imageSmoothingQuality = 'high';
                        blur.drawImage(bitmap, 0, 0, sw, sh);
                        ctx.drawImage(small, 0, 0, width, height);
                    }
                } else {
                    ctx.globalCompositeOperation = 'copy';
                }
            } catch(e) {
                if(!this.userdata.warned) {
                    this.userdata.warned = true;
                    console.warn('Background frame unavailable:', e);
                    displayWarning('Effet vidéo interrompu. L’image est masquée.');
                }
                this.userdata.worker?.terminate();
                this.userdata.worker = null;
                ctx.globalCompositeOperation = 'copy';
            } finally {
                ctx.fillStyle = '#162b28';
                ctx.fillRect(0, 0, width, height);
                ctx.globalCompositeOperation = 'source-over';
                mask?.close();
                bitmap?.close();
            }
            return true;
        },
    };
}

/**
 * @type {Record.<string,filterDefinition>}
 */
let filters = {
    'mirror-h': {
        description: "Miroir horizontal",
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, 1);
            ctx.drawImage(src, -src.videoWidth, 0);
            ctx.resetTransform();
            return true;
        },
    },
    'mirror-v': {
        description: "Miroir vertical",
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(1, -1);
            ctx.drawImage(src, 0, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    'rotate': {
        description: 'Rotation à 180°',
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, -1);
            ctx.drawImage(src, -src.videoWidth, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    'background-blur': createBackgroundFilter('Flou du fond', 'blur'),
    'background-solid': createBackgroundFilter('Fond uni', 'solid'),
    'background-image': createBackgroundFilter('Image de fond', 'image'),
};

async function addFilters() {
    for(let name in filters) {
        let f = filters[name];
        if(f.predicate) {
            if(!(await f.predicate.call(f)))
                continue;
        }
        let d = f.description || name;
        addSelectOption(getSelectElement('filterselect'), d, name);
    }
}
