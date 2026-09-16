import axios from 'axios';

// FSAbutment on the Chiayi box (CADCAM-RTX5090, 192.168.50.95): custom implant abutments,
// a different project from the ezai chain that happens to share that box's gateway.
//
// There is no local instance to compare against, unlike FlowToothSDF's dev/prod pair. This
// box has no route into 192.168.50.0/24, so the only way there is the public hostname, and
// the Service Token that Cloudflare Access needs is attached by the proxy in
// vite.config.js -- server-side, so it never reaches a browser.
const FSABUTMENT_PROXY_BASE = '/api/fsabutment-rtx5090';

/**
 * The fold is NOT a free choice and nothing downstream can check it for you.
 *
 * The checkpoints are five-fold cross-validated: fold k's model never saw fold k's
 * patients. For a case in the training set, only the fold that held it out gives a
 * held-out number; any other fold is scoring a model on data it learned, and it returns a
 * perfectly plausible abutment while doing so. For a case that is not in the set, any fold
 * is as good as another.
 *
 * The mapping for the five cases staged on that box is in
 * /data/fsabutment/cases_20260915/best_cases/README.md.
 */
const FSABUTMENT_KNOWN_FOLDS = { B01: 0, C03: 1, C35: 2, C30: 4, C17: 2 };

const decodeApiError = data => {
  if (data instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(data);
    try {
      return JSON.parse(text).message ?? text;
    } catch {
      return text;
    }
  }
  if (data?.message) return data.message;
  return typeof data === 'string' ? data : null;
};

const getFSAbutmentHealth = async () => {
  const response = await axios.get(`${FSABUTMENT_PROXY_BASE}/health`);
  return response.data;
};

/**
 * Four scans in, one abutment out.
 *
 * `scStl` is the treated arch RE-SCANNED WITH THE SCAN BODIES SCREWED IN, and it is not
 * interchangeable with upper or lower: the implant frame comes from the machined post, and
 * the post exists in no other file. Which arch is treated is worked out on the server by
 * comparing SC against both.
 */
const generateFSAbutment = async ({
  upperStl,
  lowerStl,
  scStl,
  crownStl,
  fold,
  tag,
  seatCrown = true,
  site = 0,
  seed = 0,
}) => {
  const formData = new FormData();
  formData.append('upper_stl', upperStl);
  formData.append('lower_stl', lowerStl);
  formData.append('sc_stl', scStl);
  formData.append('crown_stl', crownStl);
  formData.append('fold', String(fold));
  if (tag) formData.append('tag', tag);
  formData.append('seat_crown', seatCrown ? '1' : '0');
  formData.append('site', String(site));
  formData.append('seed', String(seed));

  try {
    const response = await axios.post(
      `${FSABUTMENT_PROXY_BASE}/v1/abutments`,
      formData,
      {
        params: { job_id: `checkingviewer-${Date.now()}` },
        responseType: 'arraybuffer',
        // Synchronous on the server side: the request is held open for the GPU work, which
        // is 2-3 s a site. No polling, unlike the pipeline. Cloudflare cuts the connection
        // at 100 s regardless of what is set here.
        timeout: 0,
      },
    );

    const h = response.headers;
    const disposition = h['content-disposition'] ?? '';
    return {
      blob: new Blob([response.data], { type: 'model/ply' }),
      fileName: disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'abutment.ply',
      jobId: h['x-fsabutment-job-id'] ?? '',
      tag: h['x-fsabutment-tag'] ?? '',
      fold: h['x-fsabutment-fold'] ?? '',
      sites: Number(h['x-fsabutment-sites'] ?? 0),
      site: Number(h['x-fsabutment-site'] ?? 0),
      heightMm: Number(h['x-fsabutment-height-mm'] ?? 0),
      faces: Number(h['x-fsabutment-faces'] ?? 0),
      watertight: h['x-fsabutment-watertight'] === 'yes',
      clip: h['x-fsabutment-clip'] ?? '',
      seatCoverage: Number(h['x-fsabutment-seat-coverage'] ?? 0),
      // `off` here is not a failure: it means no CAD library was configured, so the implant
      // connection is a marching-cubes surface rather than the catalogue part's own
      // triangles -- about 0.104 mm off it, with the anti-rotation corners rounded.
      merge: h['x-fsabutment-merge'] ?? '',
      // `fallback(gX->gY)` is the emergence correction declining itself because the
      // corrected branch had more handles than the plain one. That is the guard working.
      corridor: h['x-fsabutment-corridor'] ?? '',
      seconds: Number(h['x-fsabutment-seconds'] ?? 0),
    };
  } catch (error) {
    const apiMessage = decodeApiError(error.response?.data);
    throw new Error(apiMessage || error.message || 'FSAbutment API request failed');
  }
};

export { generateFSAbutment, getFSAbutmentHealth, FSABUTMENT_KNOWN_FOLDS };
