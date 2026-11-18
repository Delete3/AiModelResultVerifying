// The stump a job builds or builds on, as the 牙冠設計 tab's controls hold it: for 「支台齒」 the
// stump itself (mode=stump), for 「PEEK abut」 the stump the crown is built over (no_abutment=true).
//
// Shapes:
//   virtual  the generic virtual stump (ezai-pipeline app/virtual_prep.py) -- PEEK abut only, its default
//   library  a stump from EZCAD's abutment library (app/library_stump.py) -- 「支台齒」's default
//   cutback  a crown built over that library stump and cut back (app/cutback_stump.py)
//
// The bounds and defaults are the service's own; it answers 422 outside them, and only what the
// user changed is sent (null = the service's choice). Both production pipelines and the dispatcher
// take library and cutback since 2026-11-17 (ezai-pipeline f01a7a7); cutback has two styles there
// (the user chose them on 2026-11-13).

const family = shape => (shape === 'virtual' ? 'virtual' : 'library');

const HEIGHT = {
  virtual: { range: [1.0, 6.0], initial: 3.0 },
  library: { range: [1.5, 8.0], initial: 4.0 },
};
const SHOULDER_RANGE = [0.3, 1.5];
const DEFAULT_SHOULDER = { virtual: 0.8, library: 0.6 };
const CLEARANCE_RANGE = [0.5, 3.0];
const DEFAULT_CLEARANCE = 1.0;
// scaled (2026-11-13): ring's shoulder and walls, the crown's own occlusal form scaled in plan into
// the stump's top; ring (2026-10-14): walls and occlusal (along the axis) from the ring. Always sent
// by name.
const CUTBACK_STYLES = [
  { value: 'scaled', name: '等比縮小', label: '等比縮小（預設）' },
  { value: 'ring', name: '舊版', label: '舊版' },
];
const STYLE_NAME = Object.fromEntries(CUTBACK_STYLES.map(s => [s.value, s.name]));
const CUTBACK_RANGE = [0.5, 2.5];
const OCCLUSAL_RANGE = [0.5, 3.0];
const DEFAULT_CUTBACK = { scaled: 1.0, ring: 1.0 };
const DEFAULT_OCCLUSAL = 1.8;

const SHAPE_LABEL = { virtual: '通用虛擬支台齒', library: '資料庫支台齒', cutback: 'Cutback 支台齒' };
const AXIS_SOURCE = { natural: '自然傾斜', view: '目前視角', manual: '指定' };

const initialSpec = shape => ({
  shape,
  heightMode: 'auto',
  height: HEIGHT[family(shape)].initial,
  shoulder: DEFAULT_SHOULDER[family(shape)],
  clearance: DEFAULT_CLEARANCE,
  cutbackStyle: 'scaled',
  cutbackMm: DEFAULT_CUTBACK.scaled,
  occlusalMm: DEFAULT_OCCLUSAL,
  axisMode: 'natural',
  axis: [0, 0, 1],
  viewAxis: null,
});

/** Another shape; between the virtual stump and the library ones, the numbers with other bounds start over. */
const withShape = (spec, shape) => (family(shape) === family(spec.shape)
  ? { ...spec, shape }
  : { ...spec, shape, height: HEIGHT[family(shape)].initial, shoulder: DEFAULT_SHOULDER[family(shape)] });

const isLibrary = spec => family(spec.shape) === 'library';
const axisOk = spec => spec.axis.every(Number.isFinite) && Math.hypot(...spec.axis) > 1e-6;

/** The insertion axis that will be sent ([x, y, z], the scans' frame), or null for the natural lean. */
const sentAxis = spec => {
  if (!isLibrary(spec)) return null;
  if (spec.axisMode === 'manual') return axisOk(spec) ? spec.axis : null;
  return spec.axisMode === 'view' ? spec.viewAxis : null;
};

/** What is missing before this stump can be sent. */
const specBlockers = spec => {
  if (!isLibrary(spec)) return [];
  if (spec.axisMode === 'manual' && !axisOk(spec)) return ['插入方向不能是 0,0,0'];
  if (spec.axisMode === 'view' && !spec.viewAxis) return ['把畫面轉到要的插入方向，按「設為目前視角」'];
  return [];
};

// With the cutback, height and clearance belong to the library stump the crown is built over --
// the cut-back stump's own height follows from the crown -- so they are not sent.
const libraryFields = spec => {
  const cutback = spec.shape === 'cutback';
  return {
    height: spec.heightMode === 'manual' && !cutback ? spec.height : null,
    shoulder: spec.shoulder !== DEFAULT_SHOULDER.library ? spec.shoulder : null,
    clearance: spec.clearance !== DEFAULT_CLEARANCE && !cutback ? spec.clearance : null,
    axis: sentAxis(spec),
    cutback: cutback ? {
      cutbackStyle: spec.cutbackStyle,
      cutbackMm: spec.cutbackMm !== DEFAULT_CUTBACK[spec.cutbackStyle] ? spec.cutbackMm : null,
      cutbackOcclusalMm: spec.occlusalMm !== DEFAULT_OCCLUSAL ? spec.occlusalMm : null,
    } : null,
  };
};

/** runPipelineJob's `stump` (mode=stump). */
const stumpOption = spec => {
  const f = libraryFields(spec);
  return {
    heightMm: f.height,
    shoulderMm: f.shoulder,
    clearanceMm: f.clearance,
    insertionAxis: f.axis,
    ...(f.cutback ? { shape: 'cutback', ...f.cutback } : {}),
  };
};

/** runPipelineJob's `noAbutment` (PEEK abut). */
const noAbutmentOption = spec => {
  if (!isLibrary(spec)) {
    return {
      stumpHeightMm: spec.heightMode === 'manual' ? spec.height : null,
      stumpShoulderMm: spec.shoulder !== DEFAULT_SHOULDER.virtual ? spec.shoulder : null,
    };
  }
  const f = libraryFields(spec);
  return {
    stumpShape: spec.shape,
    stumpHeightMm: f.height,
    stumpShoulderMm: f.shoulder,
    clearanceMm: f.clearance,
    insertionAxis: f.axis,
    ...(f.cutback ?? {}),
  };
};

export {
  AXIS_SOURCE, CLEARANCE_RANGE, CUTBACK_RANGE, CUTBACK_STYLES, DEFAULT_CLEARANCE, DEFAULT_CUTBACK, DEFAULT_OCCLUSAL,
  DEFAULT_SHOULDER, HEIGHT, OCCLUSAL_RANGE, SHAPE_LABEL, SHOULDER_RANGE, STYLE_NAME,
  family, initialSpec, isLibrary, noAbutmentOption, sentAxis, specBlockers, stumpOption, withShape,
};
