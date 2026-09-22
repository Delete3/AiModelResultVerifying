// ezai-pipeline app/peek_lower.py DEFAULTS -- keep the two in step. null is "auto": the
// service estimates it from the scan's soft-tissue tunnel.
const PEEK_DEFAULTS = {
  interface_diameter_mm: 4.0,
  chimney_diameter_mm: 3.2,
  chimney_height_mm: 4.0,
  collar_height_mm: 0.8,
  depth_mm: null,
  offset_md_mm: null,
  offset_bl_mm: null,
  tilt_md_deg: 0,
  tilt_bl_deg: 0,
  profile: 0,
  cavity: true,
};

/** Only what differs from the defaults goes to the service, so its record says what was asked. */
const peekOverrides = params => Object.fromEntries(
  Object.entries(params).filter(([key, value]) => value !== PEEK_DEFAULTS[key]),
);

export { PEEK_DEFAULTS, peekOverrides };
