import {GifReader} from './third-party/omggif/omggif.mjs';

/** @param {ArrayBuffer} data */
export function loadGifBackground(data) {
    let reader = new GifReader(new Uint8Array(data));
    let {width, height} = reader;
    if(!width || !height || Math.max(width, height) > 1920 ||
       width * height > 1920 * 1080 || reader.numFrames() < 1) {
        throw new Error('Choisis un GIF de 1 920 pixels maximum par côté et de 2,1 mégapixels maximum.');
    }

    for(let i = 0; i < reader.numFrames(); i++) {
        let frame = reader.frameInfo(i);
        if(!frame.width || !frame.height ||
           frame.x + frame.width > width || frame.y + frame.height > height) {
            throw new Error('Le GIF contient une image hors de son cadre.');
        }
    }

    let canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let context = canvas.getContext('2d');
    let image = context.createImageData(width, height);
    let pixels = image.data;
    /** @type {Uint8ClampedArray | null} */
    let previousPixels = null;
    let index = -1;
    /** @type {number | null} */
    let deadline = null;
    let delay = 100;

    function advance() {
        let next = (index + 1) % reader.numFrames();
        if(next === 0) {
            pixels.fill(0);
        } else {
            let previous = reader.frameInfo(index);
            if(previous.disposal === 2) {
                for(let y = previous.y; y < previous.y + previous.height; y++) {
                    let start = (y * width + previous.x) * 4;
                    pixels.fill(0, start, start + previous.width * 4);
                }
            } else if(previous.disposal === 3 && previousPixels) {
                pixels.set(previousPixels);
            }
        }

        let frame = reader.frameInfo(next);
        if(frame.disposal === 3) {
            if(!previousPixels)
                previousPixels = new Uint8ClampedArray(pixels.length);
            previousPixels.set(pixels);
        }
        reader.decodeAndBlitFrameRGBA(next, pixels);
        index = next;
        delay = Math.max(20, frame.delay * 10 || 100);
    }

    advance();
    context.putImageData(image, 0, 0);

    return {
        /** @param {number} now */
        frame(now) {
            if(reader.numFrames() === 1)
                return canvas;

            if(deadline === null)
                deadline = now + delay;
            if(now < deadline)
                return canvas;

            // Bound work per video frame, especially after returning to a tab.
            for(let step = 0; now >= deadline && step < 4; step++) {
                advance();
                deadline += delay;
            }
            if(now >= deadline)
                deadline = now + delay;

            context.putImageData(image, 0, 0);
            return canvas;
        },
    };
}
