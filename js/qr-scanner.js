// In-app QR scanner: camera → canvas → jsQR. The library loads only when scanning starts.
import { loadScript } from './ui.js';

const JSQR_LIBRARY = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const MAX_SCAN_WIDTH = 640;  // smaller frames scan faster on phones

// Starts the camera in `video` and calls onResult(text) once a QR code is read.
// Returns a stop() function. Throws if the camera can't start (e.g. permission denied).
export async function startScanner(video, onResult) {
  await loadScript(JSQR_LIBRARY);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });

  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;

  function stop() {
    stopped = true;
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }

  function scan() {
    if (stopped) return;
    if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
      const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (result?.data) {
        stop();
        onResult(result.data);
        return;
      }
    }
    requestAnimationFrame(scan);
  }

  requestAnimationFrame(scan);
  return stop;
}
