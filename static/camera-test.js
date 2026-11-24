// Copyright (c) 2026 by Juliusz Chroboczek.

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
 * Get a set of constraints for requesting camera and microphone permissions.
 *
 * @returns {Promise<MediaStreamConstraints>}
 */
async function getPermissionsConstraints() {
    let video = false, audio = false;
    let devices = await navigator.mediaDevices.enumerateDevices();
    devices.forEach(d => {
        if(d.kind === 'videoinput')
            video = true;
        else if(d.kind === 'audioinput')
            audio = true;
    });
    let res = {};
    if(audio)
        res['audio'] = true;
    if(video)
        res['video'] = true;
    return res;
}

/**
 * CameraTest encapsulates the camera and video test UI.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLSelectElement} videoselect
 * @param {HTMLSelectElement} audioselect
 *
 * @constructor
 */

function CameraTest(video, canvas, videoselect, audioselect) {
    /** @type {HTMLVideoElement} */
    this.video = video;
    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;
    /** @type {HTMLSelectElement}  */
    this.videoselect = videoselect;
    /** @type {HTMLSelectElement}  */
    this.audioselect = audioselect;
    /** @type {AnalyserNode} */
    this.analyser = null;
    /** @type {Uint8Array} */
    this.analyserData = null;
    /** @type {number} */
    this.drawId = null;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = null;
    /** @type {AudioContext} */
    this.audioContext = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {Filter|null} */
    this.filter = null;
    this.filterRevision = 0;
    this.streamRevision = 0;
}

CameraTest.prototype.reflectSettings = function() {
    let settings = getSettings();
    let store = false;

    if(!settings.hasOwnProperty('video') ||
       !selectOptionAvailable(this.videoselect, settings.video)) {
        settings.video = selectOptionDefault(this.videoselect);
        store = true;
    }
    this.videoselect.value = settings.video;

    if(!settings.hasOwnProperty('audio') ||
       !selectOptionAvailable(this.audioselect, settings.audio)) {
        settings.audio = selectOptionDefault(this.audioselect);
        store = true;
    }
    this.audioselect.value = settings.audio;

    if(store)
        storeSettings(settings);
}

/**
 * @param {MediaStream} s
 */
function stopStream(s) {
    s.getTracks().forEach(t => {
        try {
            t.stop();
        } catch(e) {
            console.warn(e);
        }
    });
}

CameraTest.prototype.stopStream = async function() {
    this.filterRevision++;
    this.streamRevision++;
    let stream = this.stream;
    let filter = this.filter;
    this.stream = null;
    this.filter = null;
    this.video.srcObject = null;
    if(stream)
        stopStream(stream);
    if(filter)
        await filter.stop();
}

/** @param {filterDefinition|undefined} definition */
CameraTest.prototype.setFilter = async function(definition) {
    let revision = ++this.filterRevision;
    let stream = this.stream;
    let previous = this.filter;
    this.filter = null;
    this.video.srcObject = definition ? null : stream;
    if(previous)
        await previous.stop();
    if(revision !== this.filterRevision || !definition ||
       !stream?.getVideoTracks().length)
        return;

    let filter = new Filter(stream, definition);
    await filter.start();
    if(revision !== this.filterRevision) {
        await filter.stop();
        return;
    }
    this.filter = filter;
    this.video.srcObject = filter.outputStream;
}

/**
 * @param {boolean} force
 * @param {{audio: boolean, video: boolean}} selection
 */
CameraTest.prototype.setStream = async function(force, selection) {
    if(!force && !this.stream)
        return;
    await this.stopStream();

    let settings = getSettings();
    /** @type{boolean|MediaTrackConstraints} */
    let a = (selection?.audio ?? true) && settings.audio ? {deviceId: settings.audio} : false;
    /** @type{boolean|MediaTrackConstraints} */
    let v = (selection?.video ?? true) && settings.video ? {deviceId: settings.video} : false;
    if(v) {
        let resolution = settings.resolution;
        if(resolution) {
            v.width = { ideal: resolution[0] };
            v.height = { ideal: resolution[1] };
        } else if(settings.blackboardMode) {
            v.width = { min: 640, ideal: 1920 };
            v.height = { min: 400, ideal: 1080 };
        } else {
            v.aspectRatio = { ideal: 4/3 };
        }
    }

    if(!a && !v)
        return;
    let revision = this.streamRevision;
    let stream = await navigator.mediaDevices.getUserMedia({audio: a, video: v});
    if(revision !== this.streamRevision) {
        stopStream(stream);
        return;
    }
    this.stream = stream;
    try {
        const name = getSettings().filter;
        await this.setFilter(name === '' ? undefined : filters[name] || filters['background-blur']);
    } catch(e) {
        console.warn('Effet indisponible dans l’aperçu :', e);
    }
    if(this.video.srcObject)
        await this.video.play();
}

CameraTest.prototype.startAnalyser = async function() {
    if(!this.ctx)
        this.ctx = this.canvas.getContext('2d');
    if (!this.ctx)
        throw new Error("Couldn't get context for canvas");
    if(this.analyser)
        await this.stopAnalyser();

    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    let src = this.stream;
    if(!(src instanceof MediaStream))
        throw new Error('Unexpected type for srcObject');
    let source = this.audioContext.createMediaStreamSource(src);
    source.connect(this.analyser);
    if(this.audioContext.state === "suspended") {
        this.audioContext.resume();
    }
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);

    if(!this.drawId)
        this.drawId = requestAnimationFrame(e => this.drawFFT());
}

CameraTest.prototype.stopAnalyser = async function() {
    if(!this.analyser)
        return;
    try {
        this.analyser.disconnect();
    } finally {
        this.analyserData = null;
        this.analyser = null;
        await this.audioContext.close();
        this.audioContext = null;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}

CameraTest.prototype.setAnalyser = async function() {
    if(this.video.srcObject instanceof MediaStream && this.video.srcObject.getAudioTracks().length) {
        await this.startAnalyser();
    } else {
        await this.stopAnalyser();
    }
}

CameraTest.prototype.drawFFT = function() {
    if(!this.analyser) {
        this.drawId = null;
        return;
    }

    this.drawId = requestAnimationFrame(e => this.drawFFT());

    function drawText(ctx, text, x, y, position) {
        let metrics = ctx.measureText(text);
        let xx;
        switch(position) {
        case 'left':
            xx = x;
            break;
        case 'centered':
            xx = x - metrics.width / 2;
            break;
        case 'right':
            xx = x - metrics.width;
            break;
        default:
            throw new Error('Bad value for position');
        }
        ctx.fillText(text, xx, y);
    }

    this.analyser.getByteFrequencyData(this.analyserData);
    let l = this.analyserData.length;
    let w = this.ctx.canvas.width;
    let w0 = w / l;
    let h = this.ctx.canvas.height;
    const lineSize = 10;
    let h0 = h - lineSize;

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = 'rgb(96, 96, 96)';
    this.ctx.font = '9px sans-serif';
    drawText(this.ctx, `0\u2009kHz`, 0, h - 2, 'left');
    drawText(this.ctx, `${this.audioContext.sampleRate / 4000}\u2009kHz`,
             w / 2, h - 2, 'centered');
    drawText(this.ctx,`${this.audioContext.sampleRate / 2000}\u2009kHz`,
             w, h - 2, 'right');
    this.ctx.fillStyle = 'rgb(64, 64, 192)';
    for(let i = 0; i < l; i++) {
        let v = this.analyserData[i] / 256;
        this.ctx.fillRect(i * w0, h0 * (1 - v) , w0, h0 * v);
    }
}

/**
 * @param {{audio: boolean, video: boolean}} selection
 */
CameraTest.prototype.setMediaChoices = async function(selection) {
    let ds = await getPermissionsConstraints();
    if(selection && !selection.audio)
        delete ds.audio;
    if(selection && !selection.video)
        delete ds.video;
    if(!('video' in ds || 'audio' in ds))
        throw new Error('No device detected');
    let stream = await navigator.mediaDevices.getUserMedia(ds);

    try {
        await new Promise((resolve, reject) => setTimeout(resolve, 200));
        let devices = await navigator.mediaDevices.enumerateDevices();

        let cn = 1, mn = 1;

        devices.forEach(d => {
            let label = d.label;
            if(d.kind === 'videoinput') {
                if(!label)
                    label = `Caméra ${cn}`;
                addSelectOption(this.videoselect, label, d.deviceId);
                cn++;
            } else if(d.kind === 'audioinput') {
                if(!label)
                    label = `Micro ${mn}`;
                addSelectOption(this.audioselect, label, d.deviceId);
                mn++;
            }
        });
    } finally {
        stopStream(stream);
    }
}
