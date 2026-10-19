import { GENERIC_DEFAULTS, GENERIC_RANGES } from '../../utils/function/peek/peekBase';
import { PLACEMENT_DEFAULTS, PLACEMENT_RANGES } from '../../utils/function/peek/implantPlacement';

// The emergence controls AIrDesign's abutment step has, applied all round: its eight
// tissue control points moved out (+) or in (-) together, and bone avoidance (the lower part
// rises straight up from the interface this far before it flares). AbutmentLoft.js's
// CONTROL_MAX_RADIAL and BONE_AVOID_MAX are 3 and 2 mm.
const TISSUE_DEFAULTS = {
  radial_mm: 0,
  bone_avoid_mm: 0,
};
const TISSUE_RANGES = {
  radial_mm: [-1, 3],
  bone_avoid_mm: [0, 2],
};

// Everything the PEEK lower part is built from. null in a placement value is "auto": an
// estimate from the scan's soft-tissue tunnel (implantPlacement.js).
const PEEK_DEFAULTS = { ...PLACEMENT_DEFAULTS, ...GENERIC_DEFAULTS, ...TISSUE_DEFAULTS };
const PEEK_RANGES = { ...PLACEMENT_RANGES, ...GENERIC_RANGES, ...TISSUE_RANGES };

// The library part picked when the library is there and nothing has been picked yet.
const DEFAULT_LIBRARY_PART = {
  system: 'Inteware Straumann(BoneLevel)',
  type: 'Straumann(BoneLevel) RC',
  subtype: '2-Piece',
};

/** A library part that exists in `index`: `wanted` if it does, else the default, else the first one. */
const pickLibraryPart = (index, wanted) => {
  const find = part => index.systems.find(s => s.name === part.system)
    ?.types.find(t => t.name === part.type)?.subtypes.some(u => u.name === part.subtype);
  if (wanted && find(wanted)) return wanted;
  if (find(DEFAULT_LIBRARY_PART)) return DEFAULT_LIBRARY_PART;
  const system = index.systems[0];
  const type = system.types[0];
  return { system: system.name, type: type.name, subtype: type.subtypes[0].name };
};

export { DEFAULT_LIBRARY_PART, PEEK_DEFAULTS, PEEK_RANGES, pickLibraryPart };
