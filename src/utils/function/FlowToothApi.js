import axios from 'axios';

const FLOWTOOTH_PROXY_BASE = '/api/flowtooth';

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

const getFlowToothHealth = async () => {
  const response = await axios.get(`${FLOWTOOTH_PROXY_BASE}/health`);
  return response.data;
};

const generateFlowToothCrown = async ({
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
      `${FLOWTOOTH_PROXY_BASE}/api/v1/crowns`,
      formData,
      {
        params: {
          job_id: `checkingviewer-${Date.now()}`,
          res,
          chamfer: chamfer ? 1 : 0,
          abutfit: abutfit ? 1 : 0,
        },
        responseType: 'arraybuffer',
        timeout: 0,
      },
    );

    const disposition = response.headers['content-disposition'] ?? '';
    const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
      ?? `generated_crown_FDI${fdi}.ply`;

    return {
      blob: new Blob([response.data], { type: 'model/ply' }),
      fileName,
      jobId: response.headers['x-flowtooth-job-id'] ?? '',
      seconds: Number(response.headers['x-flowtooth-seconds'] ?? 0),
    };
  } catch (error) {
    const apiMessage = decodeApiError(error.response?.data);
    throw new Error(apiMessage || error.message || 'FlowTooth API request failed');
  }
};

export { generateFlowToothCrown, getFlowToothHealth };
