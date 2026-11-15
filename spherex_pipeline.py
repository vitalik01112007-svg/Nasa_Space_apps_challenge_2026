# ==============================================================================
# ВИПРАВЛЕНИЙ ТА ДОПОВНЕНИЙ СКРИПТ NASA SPHEREx (ДЛЯ GOOGLE COLAB АБО ПК)
# Що виправлено порівняно з попередньою версією:
#   1. Виправлено синтаксичну помилку SQL конкатенації ('||' у TAP-запиті).
#   2. Видалено дублюючий послідовний цикл (Serial mode), який гальмував роботу вдвічі.
#   3. Додано словник усіх 5 обов'язкових тестових цілей NASA Space Apps.
#   4. Додано математичне ДОДАВАННЯ (Stack Sum) та ВІДНІМАННЯ (Difference B - A) кадрів.
#   5. Додано автоматичне збереження metadata.json та архівування для завантаження на сайт.
# ==============================================================================

import concurrent.futures
import http.client
import json
import logging
import os
import shutil
import time
import urllib.error

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.table import Table
from astropy.utils.data import conf
from astropy.visualization import ImageNormalize, ZScaleInterval, quantity_support
from astropy.wcs import WCS
from astroquery.ipac.irsa import Irsa
import matplotlib.pyplot as plt
import numpy as np
from scipy.ndimage import affine_transform

# 1. Налаштування середовища
logging.getLogger("astropy").setLevel(logging.ERROR)
conf.remote_timeout = 120
quantity_support()

# 2. Словник 5 тестових об'єктів NASA Space Apps (плюс галактика M101 для тесту)
NASA_TARGETS = {
    "Barnards_Star": {"ra": "17h57m48.498s", "dec": "+04d41m36.20s", "band": "SPHEREx-D2"},
    "WISE_0855":     {"ra": "08h55m10.831s", "dec": "-07d14m42.53s", "band": "SPHEREx-D5"},
    "Epsilon_Indi_B":{"ra": "22h04m10.52s",  "dec": "-56d46m57.7s",  "band": "SPHEREx-D3"},
    "RW_Aurigae":    {"ra": "05h07m49.57s",  "dec": "+30d24m05.2s",  "band": "SPHEREx-D3"},
    "R_Draconis":    {"ra": "16h32m43.05s",  "dec": "+66d45m15.0s",  "band": "SPHEREx-D4"},
    "M101_Demo":     {"ra": 210.80227 * u.deg, "dec": 54.34895 * u.deg, "band": "SPHEREx-D2"},
}

# ОБЕРІТЬ ЦІЛЬ ТУТ (наприклад, "Barnards_Star", "WISE_0855" або "M101_Demo"):
SELECTED_TARGET = "M101_Demo"
target_cfg = NASA_TARGETS[SELECTED_TARGET]

coord = SkyCoord(ra=target_cfg["ra"], dec=target_cfg["dec"], frame="icrs")
size = 0.1 * u.degree
bandpass = target_cfg["band"]
output_filename = f"spherex_{SELECTED_TARGET}_cutouts.fits"
output_folder = f"spherex_{SELECTED_TARGET}_png"

# 3. Виправлений SQL TAP-запит до архіву IRSA (додано оператор || для склеювання рядків)
query = f"""
SELECT
    'https://irsa.ipac.caltech.edu/' || a.uri || '?center={coord.ra.deg},{coord.dec.deg}d&size={size.value}' AS uri,
    p.time_bounds_lower
FROM spherex.artifact a
JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', {coord.ra.deg}, {coord.dec.deg}), p.poly)
      AND p.energy_bandpassname = '{bandpass}'
ORDER BY p.time_bounds_lower
"""

t1 = time.time()
results = Irsa.query_tap(query)
print(f"[{SELECTED_TARGET}] TAP query completed in {time.time() - t1:2.2f} s. Images found: {len(results)}")

if len(results) == 0:
    raise RuntimeError("За цими координатами та діапазоном у поточному релізі IRSA знімків ще немає. Спробуйте M101_Demo або інший діапазон D1..D6.")

# 4. Функція завантаження та обробки одного вирізу (cutout)
def process_cutout(row, coord, cache=False):
    with fits.open(row["uri"], cache=cache) as hdulist:
        header = hdulist[1].header
        spatial_wcs = WCS(header)
        x, y = spatial_wcs.world_to_pixel(coord)

        spectral_wcs = WCS(header, fobj=hdulist, key="W")
        spectral_wcs.sip = None
        wavelength, bandwidth = spectral_wcs.pixel_to_world(x, y)
        row["central_wavelength"] = wavelength.to(u.micrometer).value
        row["version"] = hdulist[0].header.get("VERSION", "")

        hdus = []
        for hdu in hdulist[1:]:
            hdu.header["EXTNAME"] = f"{hdu.header['EXTNAME']}{row['cutout_index']}"
            hdus.append(hdu.copy())
        row["hdus"] = hdus

def process_cutout_with_error_handling(row, coord, cache=False):
    try:
        process_cutout(row, coord, cache=cache)
    except (TimeoutError, urllib.error.HTTPError, http.client.IncompleteRead, http.client.RemoteDisconnected):
        row["hdus"] = None

# 5. ТІЛЬКИ ПАРАЛЕЛЬНЕ завантаження (у 10 разів швидше, без дублювання)
results_table = results.to_table()
results_table["cutout_index"] = range(1, len(results_table) + 1)
results_table["central_wavelength"] = np.full(len(results_table), np.nan)
results_table["version"] = np.full(len(results_table), "", dtype="U32")
results_table["hdus"] = np.full(len(results_table), None, dtype=object)

t1 = time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
    futures = [
        executor.submit(process_cutout_with_error_handling, row, coord, False)
        for row in results_table
    ]
    concurrent.futures.wait(futures)

print(f"Parallel cutout download finished in {(time.time() - t1) / 60:2.2f} minutes.")
results_table = results_table[results_table["hdus"] != None]
print(f"Successfully downloaded cutouts: {len(results_table)}")

# 6. Збереження об'єднаного MEF FITS-файлу
cols = fits.ColDefs([
    fits.Column(name="cutout_index", format="J", array=results_table["cutout_index"]),
    fits.Column(name="observation_date", format="D", array=results_table["time_bounds_lower"], unit="d"),
    fits.Column(name="central_wavelength", format="D", array=results_table["central_wavelength"], unit="um"),
    fits.Column(name="version", format="A32", array=results_table["version"]),
    fits.Column(name="access_url", format="A200", array=results_table["uri"]),
])
table_hdu = fits.BinTableHDU.from_columns(cols)
table_hdu.header["EXTNAME"] = "CUTOUT_INFO"

hdulist_list = [fits.PrimaryHDU(), table_hdu]
hdulist_list.extend(hdu for fits_hdulist in results_table["hdus"] for hdu in fits_hdulist)
fits.HDUList(hdulist_list).writeto(output_filename, overwrite=True)

# 7. Конвертація у PNG + ДОДАВАННЯ (Stack Sum) та ВІДНІМАННЯ (Subtraction B - A)
os.makedirs(output_folder, exist_ok=True)
summary_table = Table.read(output_filename, hdu=1)

aligned_matrices = []
metadata_records = []

with fits.open(output_filename) as hdul:
    ref_wcs = None
    ref_shape = None

    for row in summary_table:
        idx = int(row["cutout_index"])
        wl = float(row["central_wavelength"])
        obs_date = float(row["observation_date"])
        img_hdu = hdul[f"IMAGE{idx}"]
        img_data = np.nan_to_num(img_hdu.data.astype(float), nan=0.0)

        # Зберігаємо кожен окремий кадр у PNG
        norm = ImageNormalize(img_data, interval=ZScaleInterval())
        png_name = f"cutout_{idx:03d}_wl_{wl:.3f}um.png"
        plt.imsave(os.path.join(output_folder, png_name), img_data, cmap="inferno", norm=norm, origin="lower")

        if ref_shape is None:
            ref_shape = img_data.shape
        if img_data.shape == ref_shape:
            aligned_matrices.append(img_data)

        metadata_records.append({
            "index": idx,
            "filename": png_name,
            "wavelength_um": round(wl, 4),
            "mjd_date": round(obs_date, 5)
        })

# 8. Генерація математичної СУМИ (A + B) та РІЗНИЦІ (B - A)
if len(aligned_matrices) >= 2:
    # Сума всіх кадрів (підсилення сигналу тьмяних об'єктів)
    stacked_sum = np.mean(aligned_matrices, axis=0)
    norm_sum = ImageNormalize(stacked_sum, interval=ZScaleInterval())
    plt.imsave(os.path.join(output_folder, "00_STACKED_SUM.png"), stacked_sum, cmap="inferno", norm=norm_sum, origin="lower")

    # Віднімання останнього та першого кадру (виявлення руху або змінності)
    diff_sub = aligned_matrices[-1] - aligned_matrices[0]
    vmax = np.percentile(np.abs(diff_sub), 99)
    plt.imsave(os.path.join(output_folder, "00_DIFFERENCE_SUBTRACT.png"), diff_sub, cmap="coolwarm", vmin=-vmax, vmax=vmax, origin="lower")

# Зберігаємо паспорт даних metadata.json
with open(os.path.join(output_folder, "metadata.json"), "w", encoding="utf-8") as f:
    json.dump({"target": SELECTED_TARGET, "frames": metadata_records}, f, indent=2)

# Пакуємо все у ZIP-архів
zip_name = f"spherex_{SELECTED_TARGET}_images"
shutil.make_archive(zip_name, "zip", output_folder)
print(f"Готово! Створено архів {zip_name}.zip (кадри + 00_STACKED_SUM.png + 00_DIFFERENCE_SUBTRACT.png).")

try:
    from google.colab import files
    files.download(f"{zip_name}.zip")
except ImportError:
    pass
