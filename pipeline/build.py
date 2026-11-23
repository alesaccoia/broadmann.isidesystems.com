"""Converte fsaverage (FreeSurfer) in binari compatti per il viewer web.

Uso:  pipeline/.venv/bin/python pipeline/build.py
Input:  raw/fsaverage/  (scaricato con mne.datasets.fetch_fsaverage)
Output: web/data/

Etichette per vertice (uint8):
  1..47  area di Brodmann (annotazione PALS-B12, Van Essen 2005)
  48     insula (da Desikan-Killiany, dove PALS-B12 non assegna un'area)
  0      non assegnato
  255    parete mediale (non corteccia)
"""
import json
from pathlib import Path

import nibabel as nib
import nibabel.freesurfer as fs
import numpy as np
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
FS = ROOT / "raw" / "fsaverage"
OUT = ROOT / "web" / "data"
OUT.mkdir(parents=True, exist_ok=True)

INFLATED_OFFSET = 46.0  # mm: separa i due emisferi gonfiati


def normals(v, f):
    n = np.zeros_like(v, dtype=np.float64)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    for i in range(3):
        np.add.at(n, f[:, i], fn)
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    return n


def brodmann_labels(hemi):
    lab, _, names = fs.read_annot(FS / "label" / f"{hemi}.PALS_B12_Brodmann.annot")
    names = [x.decode() for x in names]
    ap, _, apn = fs.read_annot(FS / "label" / f"{hemi}.aparc.annot")
    apn = [x.decode() for x in apn]
    ap = np.where(ap < 0, 0, ap)
    lut = np.zeros(len(names), dtype=np.uint8)
    for i, n in enumerate(names):
        if n.startswith("Brodmann."):
            lut[i] = int(n.split(".")[1])
        elif n == "MEDIAL.WALL":
            lut[i] = 255
    out = lut[np.where(lab < 0, 0, lab)]
    out[(out == 0) & (ap == apn.index("insula"))] = 48
    out[(ap == 0) & (out == 0)] = 255
    return out, ap.astype(np.uint8), apn


meta = {"hemis": {}, "inflatedOffset": INFLATED_OFFSET}
ribbon_pts = []

for hemi in ("lh", "rh"):
    pial, faces = fs.read_geometry(FS / "surf" / f"{hemi}.pial")
    white, _ = fs.read_geometry(FS / "surf" / f"{hemi}.white")
    infl, _ = fs.read_geometry(FS / "surf" / f"{hemi}.inflated")
    infl = infl.copy()
    infl[:, 0] += -INFLATED_OFFSET if hemi == "lh" else INFLATED_OFFSET
    sulc = fs.read_morph_data(FS / "surf" / f"{hemi}.sulc")
    ba, ap, apn = brodmann_labels(hemi)

    pial.astype("<f4").tofile(OUT / f"{hemi}.pial.f32")
    infl.astype("<f4").tofile(OUT / f"{hemi}.infl.f32")
    (normals(pial, faces) * 127).astype(np.int8).tofile(OUT / f"{hemi}.pial.n8")
    (normals(infl, faces) * 127).astype(np.int8).tofile(OUT / f"{hemi}.infl.n8")
    faces.astype("<u4").tofile(OUT / f"{hemi}.faces.u32")
    ba.tofile(OUT / f"{hemi}.ba.u8")
    ap.tofile(OUT / f"{hemi}.aparc.u8")
    np.clip(sulc / 2.0 * 127, -127, 127).astype(np.int8).tofile(OUT / f"{hemi}.sulc.i8")

    meta["hemis"][hemi] = {"vertices": int(len(pial)), "faces": int(len(faces))}
    meta["aparc"] = apn
    counts = {int(k): int(c) for k, c in zip(*np.unique(ba, return_counts=True))}
    meta["hemis"][hemi]["counts"] = counts
    # centroide di ogni area sulla superficie piale (per orientare la camera)
    meta["hemis"][hemi]["centroids"] = {
        int(k): [round(float(x), 1) for x in pial[ba == k].mean(0)] for k in counts if 0 < k < 255
    }
    for t in np.linspace(0.0, 1.0, 9):
        ribbon_pts.append((white + (pial - white) * t, ba))
    print(hemi, len(pial), "vertici;", sum(1 for k in counts if 0 < k < 48), "aree di Brodmann")

# --- Volume per le sezioni: T1 (brain.mgz) e aree proiettate nel nastro corticale ---
img = nib.load(FS / "mri" / "brain.mgz")
t1 = np.asarray(img.dataobj)
ras2vox = np.linalg.inv(img.header.get_vox2ras_tkr())

lab = np.zeros(t1.shape, dtype=np.uint8)
for pts, ba in ribbon_pts:
    keep = (ba > 0) & (ba < 255)
    ijk = np.rint(pts[keep] @ ras2vox[:3, :3].T + ras2vox[:3, 3]).astype(int)
    lab[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = ba[keep]
# chiude i buchi del nastro: ogni voxel di corteccia prende l'etichetta piu' vicina entro 1.5 mm
ribbon = np.asarray(nib.load(FS / "mri" / "ribbon.mgz").dataobj)
cortex = (ribbon == 3) | (ribbon == 42)
dist, idx = ndimage.distance_transform_edt(lab == 0, return_indices=True)
fill = cortex & (lab == 0) & (dist <= 1.5)
lab[fill] = lab[idx[0][fill], idx[1][fill], idx[2][fill]]
lab[~cortex] = 0

# riorienta in assi RAS (x destra, y avanti, z alto) a 1 mm, poi ritaglia sul cervello
# tkr: x = 128 - i ; y = k - 128 ; z = 128 - j
def to_ras(a):
    return a.transpose(0, 2, 1)[::-1, :, ::-1]

t1r, labr = to_ras(t1), to_ras(lab)
nz = np.argwhere(t1r > 0)
lo, hi = nz.min(0) - 2, nz.max(0) + 3
t1c = t1r[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
labc = labr[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
t1c = np.clip(t1c.astype(np.float32) / 110.0 * 255, 0, 255).astype(np.uint8)
# ordine per Data3DTexture: x varia piu' velocemente
t1c.transpose(2, 1, 0).tofile(OUT / "vol.t1.u8")
labc.transpose(2, 1, 0).tofile(OUT / "vol.ba.u8")
# voxel RAS index r -> coordinata mm: indice 0 dell'asse invertito corrisponde a -127 (x), -128 (y), -127 (z)
origin = [float(lo[0] - 127 - 0.5), float(lo[1] - 128 - 0.5), float(lo[2] - 127 - 0.5)]
meta["volume"] = {"shape": [int(s) for s in t1c.shape], "origin": origin}
print("volume", t1c.shape, "origine", origin, "voxel etichettati", int((labc > 0).sum()))

(OUT / "meta.json").write_text(json.dumps(meta))
