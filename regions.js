// Region catalog for TIDO. Ids, names, centers and bounds follow the data
// server's catalog (Coast Watch: shared/stations.js). Station details arrive with every
// snapshot; the id lists below only let a ?station= link find its region.

export const REGIONS = {
  sfbay: {
    id: "sfbay",
    gauges: ["9415020", "9414290", "9414863", "9414750", "9414523", "9415102", "9415144", "9413450"],
    buoys: ["46013", "46214", "46026", "46237", "46012", "46042", "46236", "FTPC1", "PXOC1", "OKXC1", "LNDC1", "AAMC1", "PPXC1", "RCMC1", "RTYC1", "UPBC1", "OMHC1", "MZXC1", "PCOC1", "PSBC1", "SFXC1", "PRYC1", "BDXC1", "46092", "MLSC1", "ELXC1", "MEYC1"],
    code: "SFBAY",
    name: "SF BAY AREA",
    tz: "America/Los_Angeles",
    center: [-122.38, 37.72],
    zoom: 8.7,
    maxBounds: [[-126.5, 34.5], [-118.5, 40.8]],
  },
  puget: {
    id: "puget",
    gauges: ["9447130", "9446484", "9445958", "9444900", "9449880", "9449424", "9444090", "9443090", "9442396", "9441102"],
    buoys: ["46088", "46267", "46087", "46041", "46211", "WPOW1", "TCMW1", "TCNW1", "BMTW1", "PTWW1", "PTAW1", "FRDW1", "SISW1", "PBFW1", "46118", "CPMW1", "NEAW1", "LAPW1", "46119", "DESW1", "WPTW1", "46099"],
    code: "PUGET",
    name: "PUGET SOUND",
    tz: "America/Los_Angeles",
    center: [-122.85, 47.9],
    zoom: 7.9,
    maxBounds: [[-127.5, 45.6], [-119.5, 50.3]],
  },
  sfla: {
    id: "sfla",
    gauges: ["8722670", "8722956", "8723214", "8723970", "8724580", "8725114", "8725520"],
    buoys: ["41122", "42095", "LONF1", "SMKF1", "VAKF1", "PEGF1", "LKWF1", "VCAF1", "KYWF1", "SANF1", "FMRF1", "RKXF1", "MNBF1", "BWSF1", "LBSF1", "LSNF1", "JBYF1", "TRRF1", "WRBF1"],
    code: "SFLA",
    name: "MIAMI / SOUTH FLORIDA",
    tz: "America/New_York",
    center: [-80.95, 25.55],
    zoom: 7.6,
    maxBounds: [[-84.6, 23.2], [-77.8, 27.9]],
  },
};

export const REGION_IDS = Object.keys(REGIONS);
export const DEFAULT_REGION = "sfbay";

/** Region whose catalog lists this station id (null if unknown). */
export function regionOfStation(id) {
  const k = String(id || "").toUpperCase();
  for (const r of REGION_IDS) if (REGIONS[r].gauges.includes(k) || REGIONS[r].buoys.includes(k)) return r;
  return null;
}
