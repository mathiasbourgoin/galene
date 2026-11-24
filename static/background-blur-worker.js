// Copyright (c) 2024 by Juliusz Chroboczek.

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

let imageSegmenter;
let maskImage;
let targetMask;
let horizontalMask;
let columnSums;
let stableMask;
let lastMaskTimestamp;

function backgroundOpacity(confidence, lower, upper) {
    if(!(confidence > lower))
        return 255;
    if(confidence >= upper)
        return 0;
    const t = (confidence - lower) / (upper - lower);
    return 255 * (1 - t * t * (3 - 2 * t));
}

/**
 * @param {Float32Array} confidence
 * @param {number} width
 * @param {number} height
 * @param {number} timestamp
 */
function softenMask(confidence, width, height, timestamp) {
    if(!maskImage || maskImage.width !== width || maskImage.height !== height) {
        maskImage = new ImageData(width, height);
        targetMask = new Uint8ClampedArray(confidence.length);
        horizontalMask = new Uint8ClampedArray(confidence.length);
        columnSums = new Uint16Array(width);
        stableMask = new Float32Array(confidence.length);
        lastMaskTimestamp = undefined;
    }

    let foregroundPixels = 0;
    for(let i = 0; i < confidence.length; i++) {
        const p = confidence[i];
        targetMask[i] = backgroundOpacity(p, .74, .96);
        if(p > .74)
            foregroundPixels++;
    }

    // Keep the feather proportional to the video, with a cost independent of
    // its radius. Extend the border pixels to avoid making the frame translucent.
    const radius = Math.max(2, Math.min(9, Math.round(Math.min(width, height) / 105)));
    const span = 2 * radius + 1;
    for(let y = 0; y < height; y++) {
        const row = y * width;
        let sum = radius * targetMask[row];
        for(let x = 0; x <= radius; x++)
            sum += targetMask[row + Math.min(x, width - 1)];
        for(let x = 0; x < width; x++) {
            horizontalMask[row + x] = sum / span;
            sum += targetMask[row + Math.min(x + radius + 1, width - 1)] -
                targetMask[row + Math.max(x - radius, 0)];
        }
    }

    const elapsed = timestamp - lastMaskTimestamp;
    const continuous = elapsed > 0 && elapsed < 250;
    const hideHistory = continuous ? Math.exp(-elapsed / 60) : 0;
    const revealHistory = continuous ? Math.exp(-elapsed / 120) : 0;
    // Treat a nearly full-frame foreground as ambiguous and hide all of it.
    const ambiguous = foregroundPixels > confidence.length * 0.85;
    lastMaskTimestamp = timestamp;
    for(let x = 0; x < width; x++) {
        let sum = radius * horizontalMask[x];
        for(let y = 0; y <= radius; y++)
            sum += horizontalMask[Math.min(y, height - 1) * width + x];
        columnSums[x] = sum;
    }
    for(let y = 0; y < height; y++) {
        const row = y * width;
        const next = Math.min(y + radius + 1, height - 1) * width;
        const previous = Math.max(y - radius, 0) * width;
        for(let x = 0; x < width; x++) {
            const index = row + x;
            const clear = 255 - columnSums[x] / span;
            // Taper inwards so the protected side of the edge stays opaque.
            const alpha = 255 - clear * clear / 255;
            const delta = stableMask[index] - alpha;
            // An area has to remain foreground for longer before it clears.
            // A pixel that is clearly background again is hidden immediately.
            const weight = delta > 0 ? revealHistory : hideHistory;
            const floor = backgroundOpacity(confidence[index], .60, .89);
            const stableAlpha = ambiguous ? 255 : Math.max(floor, alpha + delta * weight);
            stableMask[index] = stableAlpha;
            maskImage.data[4 * index + 3] = stableAlpha;
            columnSums[x] += horizontalMask[next + x] - horizontalMask[previous + x];
        }
    }
    return maskImage;
}

async function loadImageSegmenter(model) {
    let module = await import('/third-party/tasks-vision/vision_bundle.mjs');
    let vision = await module.FilesetResolver.forVisionTasks(
        "/third-party/tasks-vision/wasm"
    );

    /** @param {'GPU' | 'CPU'} delegate */
    function createSegmenter(delegate) {
        return module.ImageSegmenter.createFromOptions(vision, {
            canvas: new OffscreenCanvas(1, 1),
            baseOptions: {
                modelAssetPath: model,
                delegate: delegate,
            },
            outputCategoryMask: false,
            outputConfidenceMasks: true,
            runningMode: 'VIDEO',
        });
    }

    // Avoid asking for the GPU delegate when WebGL is software-emulated.
    let context = new OffscreenCanvas(1, 1).getContext('webgl2', {
        failIfMajorPerformanceCaveat: true,
    });
    if(context) {
        let info = context.getExtension('WEBGL_debug_renderer_info');
        let renderer = info && context.getParameter(info.UNMASKED_RENDERER_WEBGL);
        context.getExtension('WEBGL_lose_context')?.loseContext();
        if(!renderer || !/swiftshader|llvmpipe|softpipe|software rasterizer/i.test(renderer)) {
            try {
                return await createSegmenter('GPU');
            } catch(e) {
                console.warn('GPU segmentation unavailable, retrying on CPU:', e);
            }
        }
    }

    return await createSegmenter('CPU');
}

async function foregroundMask(bitmap, timestamp) {
    if(!(bitmap instanceof ImageBitmap))
        throw new Error('Bad type for worker data');

    try {
        let id;
        imageSegmenter.segmentForVideo(bitmap, timestamp, result => {
            // The bundled Selfie model has one confidence channel, for people.
            const masks = result.confidenceMasks;
            if(masks.length !== 1)
                throw new Error('Unexpected foreground confidence output');
            const mask = masks[0];
            id = softenMask(mask.getAsFloat32Array(), mask.width, mask.height, timestamp);
        });

        let ib = await createImageBitmap(id, {
            resizeWidth: bitmap.width,
            resizeHeight: bitmap.height,
        });
        return {
            bitmap: bitmap,
            mask: ib,
        };
    } catch(e) {
        bitmap.close();
        throw(e);
    }
}

onmessage = async e => {
    try {
        let data = e.data;
        if(data.model) {
            if(imageSegmenter)
                throw new Error("image segmenter already initialised");
            imageSegmenter = await loadImageSegmenter(data.model);
            if(!imageSegmenter)
                throw new Error("loadImageSegmenter returned null");
            postMessage(null);
        } else if(data.bitmap) {
            if(imageSegmenter == null)
                throw new Error("image segmenter not initialised");
            let mask = await foregroundMask(data.bitmap, data.timestamp);
            postMessage(mask, [mask.bitmap, mask.mask]);
        } else {
            throw new Error("unexpected message type");
        }
    } catch(e) {
        postMessage(e);
    }
}
