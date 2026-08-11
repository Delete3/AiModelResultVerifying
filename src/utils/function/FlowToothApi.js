import axios from 'axios';

// The two FlowToothSDF instances on this box: 8010 (dev, follows current work) and 8013
// (prod, pinned). Both proxies are declared in vite.config.js.
const FLOWTOOTH_PROXY_BASE = {
  dev: '/api/flowtooth',
  prod: '/api/flowtooth-prod',
};

const FLOWTOOTH_MODEL_LABEL = {
  dev: 'dev',
  prod: 'prod',
};

const proxyBase = model => FLOWTOOTH_PROXY_BASE[model] ?? FLOWTOOTH_PROXY_BASE.dev;

const decodeApiError = data => {
  if (data instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(data);
    try {
      const payload = JSON.parse(text);
      const logs = Array.isArray(payload.logs) && payload.logs.length
        ? `\n${payload.logs.join('\n')}`
        : '';
      return `${payload.message ?? text}${logs}`;
    } catch {
      return text;
    }
  }

  if (data?.message) return data.message;
  return typeof data === 'string' ? data : null;
};

const getFlowToothHealth = async (model = 'dev') => {
  const response = await axios.get(`${proxyBase(model)}/health`);
  return response.data;
};

const generateFlowToothCrown = async ({
  model = 'dev',
  fdi,
  upperStl,
  lowerStl,
  marginPts,
  contactsPly,
  upperMatrix,
  lowerMatrix,
  abutmentPoints,
  res = 100,
  chamfer = true,
  abutfit = false,
}) => {
  const formData = new FormData();
  formData.append('fdi', String(fdi));
  formData.append('upper_stl', upperStl);
  formData.append('lower_stl', lowerStl);
  formData.append('margin_pts', marginPts);
  if (contactsPly) formData.append('contacts_ply', contactsPly);
  if (upperMatrix) formData.append('upper_matrix', upperMatrix);
  if (lowerMatrix) formData.append('lower_matrix', lowerMatrix);
  if (abutmentPoints) formData.append('abutment_points', abutmentPoints);

  try {
    const response = await axios.post(
      `${proxyBase(model)}/api/v1/crowns`,
      formData,
      {
        params: {
          // The model goes in the job id so the two instances' run directories, and any
          // log line either of them prints, say which weights produced the crown.
          job_id: `checkingviewer-${model}-${Date.now()}`,
          res,
          chamfer: chamfer ? 1 : 0,
          abutfit: abutfit ? 1 : 0,
        },
        responseType: 'arraybuffer',
        timeout: 0,
      },
    );

    const disposition = response.headers['content-disposition'] ?? '';
    const servedName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
      ?? `generated_crown_FDI${fdi}.ply`;
    // Both instances serve the same filename for the same tooth, so tag the file with the
    // model. Downloading one after the other must not leave two indistinguishable PLYs.
    const fileName = model === 'dev'
      ? servedName
      : servedName.replace(/(\.[^.]+)?$/, `_${model}$1`);

    return {
      blob: new Blob([response.data], { type: 'model/ply' }),
      fileName,
      model,
      modelLabel: FLOWTOOTH_MODEL_LABEL[model] ?? model,
      jobId: response.headers['x-flowtooth-job-id'] ?? '',
      seconds: Number(response.headers['x-flowtooth-seconds'] ?? 0),
    };
  } catch (error) {
    const apiMessage = decodeApiError(error.response?.data);
    throw new Error(apiMessage || error.message || 'FlowTooth API request failed');
  }
};

export { generateFlowToothCrown, getFlowToothHealth, FLOWTOOTH_MODEL_LABEL };
