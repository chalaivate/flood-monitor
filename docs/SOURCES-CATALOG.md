<!-- สำรวจเมื่อ 3 ต.ค. 2569 ด้วยการค้นเว็บ อ่านซอร์สโค้ดโครงการอ้างอิง และตรวจซ้ำแบบ adversarial -->
<!-- ยังไม่ได้ทดสอบ endpoint สดจากเครื่องที่สำรวจ (network ถูกบล็อก) รายการที่ระบุว่า "ยังไม่พิสูจน์" ต้อง probe จากเครื่องจริงก่อนใช้ -->

# รายงานแหล่งข้อมูลน้ำ ฝน และอากาศสำหรับระบบเตือนภัยน้ำท่วม (Flood Monitor)

วันที่ 3 ต.ค. 2569 (2026-10-03). รายงานนี้รวมผลสำรวจและตรวจทาน 4 ชุด: GitHub repos, API ทางการของไทย, MCP/skills และชุดข้อมูลระดับโลก

> **ข้อจำกัดของการตรวจสอบ:** container ที่ใช้สำรวจเรียก `*.go.th` ไม่ได้เลย จึงไม่มีการทดสอบ endpoint สดจากที่นี่
> ข้อมูลว่า "เรียกจาก cloud ได้หรือไม่" มาจากสองแหล่ง: (1) ไฟล์สถานะของบอทใน GitHub Actions ที่อ่านผ่าน raw.githubusercontent (ipunn, icyice1998, 3 ต.ค. 2569)
> และ (2) log การทดสอบจากเซิร์ฟเวอร์ในเยอรมนีของโครงการ flood2026 (27 ก.ย. และ 2 ต.ค. 2569). รายการที่เขียนว่า "ยังไม่พิสูจน์" ต้องทดสอบจากเครื่องจริงของเราก่อนใช้

สิ่งที่ระบบใช้อยู่แล้ว (ไม่นับเป็นของใหม่): `bma-canal`, `bma-rain`, `bma-roadflood`, `bma-pump`, `thaiwater-canal`, `thaiwater-wl`, `thaiwater-rain`, `thaiwater-road`, Open-Meteo, RainViewer และภาพเรดาร์ กทม.

---

## 1) สรุปสำหรับผู้บริหาร

- **ประกาศเตือนภัยทางการ: ใช้ TMD CAP feed** (`www.tmd.go.th/api/xml/CAP`). เป็นช่องทางที่เครื่องอ่านได้และดีที่สุด: CAP 1.2, กรมอุตุฯ ขึ้นทะเบียนเป็น alerting authority กับ WMO, ระบุพื้นที่ด้วยรหัส ISO 3166-2 (`TH-10` = กทม.) จึงจับคู่กับจังหวัดของเราได้ตรง ๆ, เรียกจาก GitHub Actions ได้ (ต้องเพิ่ม intermediate cert ของ GlobalSign). ทำเป็นแบนเนอร์ "ประกาศกรมอุตุฯ" แยกจากสถานะ freeboard ของเรา (งานขนาด S)
- **น้ำเหนือ 2–7 วัน: ใช้ HII FEWS data portal** (`fews2.hii.or.th/model-output/data_portal`). ให้พยากรณ์อัตราการไหลรายชั่วโมงที่ C.2, C.13, C.35 (ย้อนหลัง 7 วันถึงล่วงหน้า 7 วัน) และ **เกณฑ์ทางการของกรมชลประทาน 87 สถานี** (C.13 = 2,176 / 2,448 / 2,720 m³/s). เรียกจาก cloud ได้ และมี parser สัญญาอนุญาต MIT พร้อม fixture ใน flukelaster/SIAHRA ใช้เกณฑ์นี้แทนเกณฑ์ที่ตั้งเอง เช่น 2,000/3,000
- **ปริมาณน้ำในเขื่อน: ใช้ ThaiWater `analyst/dam` เป็นหลัก และ RID reservoir API เป็นแหล่งทางการ** ThaiWater ให้ข้อมูลรายชั่วโมงและเรียกจาก cloud ได้ ส่วน `app.rid.go.th/reservoir/api/dam/public[/{date}]` ให้ข้อมูลรายวันพร้อมประวัติย้อนหลัง ชุดข้อมูลนี้เผยแพร่แบบ CC-BY ใน data.go.th แต่ต้องดึงผ่านเครื่องในไทยหรือ Node/OpenSSL ใช้ทำ "การ์ดเขื่อนหลักลุ่มเจ้าพระยา" (ภูมิพล สิริกิติ์ ป่าสักฯ) แสดงทั้งปริมาณเก็บกักและปริมาณระบาย
- **ระดับน้ำแม่น้ำเทียบตลิ่ง: ใช้ RID SWOC pier API** (~1,020 สถานี) แต่ละสถานีมี `wl_values_msl` คู่กับ `brae_level_msl` (ตลิ่ง) จึงคำนวณ freeboard ด้วย engine เดิมได้ทันที นอกจากนี้มีอัตราการไหล การเปลี่ยนแปลงใน 24 ชม. และสถานี C.29A บางไทร ซึ่ง ThaiWater ไม่มี ยังไม่พิสูจน์ว่าเรียกจาก cloud ได้ จึงให้ probe จากเครื่องในไทยก่อน
- **ฝนล่วงหน้า (lead time): มีของทางการที่ไม่ต้องใช้ key สองตัว** ตัวแรกคือ ONWR WAM `/api/zones?level=district` ให้ nowcast ฝน 3 ชม. รายเขต (รหัส `TH10xx`) ตัวที่สองคือ TMD HPC riskmap JSON ให้พยากรณ์ฝนรายวันรายอำเภอ วันละ 2 รอบ พร้อมเกณฑ์ของกรมอุตุฯ ควรใช้เรดาร์ composite ของกรมอุตุฯ แทน RainViewer เพราะตั้งแต่ 1 ม.ค. 2569 RainViewer จำกัดไว้ที่ zoom 7 ใช้ได้เฉพาะส่วนบุคคลหรือการศึกษา 100 req/นาที/IP และเลิกให้ nowcast แล้ว
- **น้ำทะเลหนุน: ระบบยังไม่มีข้อมูลนี้เลย** ทางที่ใช้ได้คือ HII `tide_table/summary.txt` (ค่าคาดการณ์ 28 สถานี เรียกจาก cloud ได้ แต่ยังไม่ยืนยันว่า datum เป็น MSL) ร่วมกับหน้า `tiwrm.hii.or.th/v3/sealevel` (ค่าวัดจริงที่ป้อมพระจุลฯ และท่าเรือกรุงเทพ เป็น HTML) และประกาศน้ำทะเลหนุนของกรมอุทกศาสตร์ ไม่มี feed ระดับโลกที่ครอบคลุมปากแม่น้ำเจ้าพระยา (IOC มีเพียงสถานีเกาะตะเภาน้อยฝั่งอันดามัน)
- **ความเสี่ยงที่ต้องแก้ทันที:** feed ทวนข้อมูลคลองของ ThaiWater (`thaiwater-canal`) ซึ่งเป็นแหล่งสำรองบน cloud ของเรา **ค้างตั้งแต่ 28 ก.ย. 2569 13:30** (282 จุด) ต้องตั้ง alarm จาก `SourceHealth.latestObservationAt` ให้แจ้งผู้ดูแล
- **MCP/skills:** ยังไม่มี MCP ใดครอบคลุม ThaiWater, RID, EGAT, GISTDA หรือข้อมูลน้ำขึ้นน้ำลงของกองทัพเรือ ที่มีของไทยคือ POPNIX MCP (คลอง กทม.) และ slash commands ของ gain9999/thaiwater เท่านั้น จึงควรสร้าง **flood-monitor MCP แบบอ่านอย่างเดียว** ของเราเอง ส่วนโมเดลระดับโลก (GloFAS, Google Flood Hub) ไม่ได้ทำให้การพยากรณ์ดีขึ้นในเจ้าพระยาตอนล่างที่มีเขื่อนควบคุม จึงไม่ควรใช้ในตรรกะแจ้งเตือน

---

## 2) ตารางแหล่งข้อมูลแนะนำ

คำอธิบายคอลัมน์ **ความน่าเชื่อถือ** = ระดับที่ตรวจทานแล้ว (สูง/กลาง/ต่ำ) และระบุว่าเป็นแหล่งทางการหรือไม่ · **การเข้าถึง** = ค่าใช้จ่ายและเรียกจาก cloud ได้หรือไม่
("IP ไทย" = ต้องดึงผ่านเครื่องในไทยหรือ relay, "ยังไม่พิสูจน์" = ยังไม่มีหลักฐานว่าเรียกจาก cloud ได้)

### 2.1 ฝน

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| ONWR WAM radar/nowcast (`/api/frames`, `/api/rain_stations`, `/api/zones?level=district\|subdistrict`) | สทนช. (เรดาร์จากกรมอุตุฯ) | API (ไม่มีเอกสาร) | กลาง · ทางการ | ฟรี ไม่ต้องใช้ key · ยังไม่พิสูจน์ (มีหลักฐานจาก Cloudflare Worker เท่านั้น) | ~15 นาที | ฝนคาดการณ์ 3 ชม. รายเขต/แขวง (`TH10xx`) ใช้เป็น lead time ของการแจ้งเตือน และทำ "การ์ดฝน 3 ชม. ข้างหน้า" | https://wam.onwr.go.th/radar |
| TMD HPC riskmap รายอำเภอ (`static/images/riskmap_json/rain.YYYYMMDD.{0000\|1200}.json`) | กรมอุตุฯ (HPC/NWP) | API (ไฟล์ JSON) | กลาง · ทางการ | ฟรี · cloud ไม่ทราบ | 2 รอบ/วัน | "ฝนพยากรณ์พรุ่งนี้รายเขต (กรมอุตุฯ)" ใน WeatherCard เทียบกับ Open-Meteo เกณฑ์ของหน้า: ≥35 / ≥65 / ≥125 / >250 มม./วัน | https://hpc.tmd.go.th/riskmap-district |
| TMD radar composite (PNG 15 นาที, NetCDF, ASCII) | กรมอุตุฯ | API (ไฟล์) | สูง · ทางการ | ฟรี · cloud ไม่ทราบ | 15 นาที | ใช้แทนหรือเสริม RainViewer ใน RadarCard (มีเฉพาะภาพย้อนหลัง ไม่มี nowcast; ใช้คู่กับ WAM) | https://weather.tmd.go.th/composite/index_composite.html |
| TMD RADARGIS overlays | กรมอุตุฯ | API | กลาง · ทางการ | ฟรี · Vercel sin1 เรียกไม่ได้ ต้องใช้ IP ไทย | ระดับนาที | ภาพ dBZ ที่มีพิกัดอ้างอิง ใช้ timestamp จากชื่อไฟล์ (`valid_dt_ts` คลาดไป 7 ชม.) | https://radargis.tmd.go.th/api/overlays |
| ThaiWater ฝนสะสม `provinces/rain3d\|5d\|7d\|15d` | สสน. | API | สูง · ทางการ | ฟรี · cloud ได้ | รายวัน | ได้ฝนสะสม 3–15 วันโดยไม่ต้องรวมเอง เพิ่มใน adapter `thaiwater` เดิมได้ | `api-v3.thaiwater.net/api/v1/thaiwater30/provinces/rain3d` |
| TMD open-data API (WeatherToday/V2, 3-hour obs, 7-day forecast) | กรมอุตุฯ | API | สูง · ทางการ | ฟรี ลงทะเบียน uid/ukey · cloud ได้จาก Vercel sin1 แต่จาก GitHub Actions ผลไม่แน่นอน | 3 ชม./รายวัน | ใช้ยอดฝนทางการตรวจทาน (validation) และพยากรณ์ 7 วันรายภาค (ต้องเรียกฝั่ง server เพราะ CORS ล็อก) | https://data.tmd.go.th/api/index1.php |
| TMD NWP API (WRF) | กรมอุตุฯ | API | กลาง · ทางการ | ลงทะเบียนฟรี (OAuth bearer) | หลายรอบ/วัน | พยากรณ์ทางการรายจุด/รายพื้นที่ เป็นทางเลือกเมื่อ riskmap ใช้ไม่ได้ | https://data.tmd.go.th/nwpapi/register |
| GPM IMERG Early (ผ่าน dynamical.org Icechunk/Zarr) | NASA / dynamical.org | Dataset | สูง (ข้อมูล) · point API ไม่มีเอกสาร | ฟรี ไม่ต้องใช้ key · cloud ได้ | 30 นาที (ล่าช้า ~4.6 ชม.) | ฝนสะสม 24–72 ชม. ของลุ่มต้นน้ำ (ปิง วัง ยม น่าน ป่าสัก) ต้องระบุว่าเป็นค่าประมาณจากดาวเทียม | https://stac.dynamical.org/catalog.json |
| JAXA GSMaP_NRT / GSMaP_NOW | JAXA EORC | Dataset | กลาง | ลงทะเบียนฟรี (FTP) หรือผ่าน Earth Engine · cloud ไม่ทราบ | รายชั่วโมง / 30 นาที | ใช้แสดง "ฝนตอนนี้" เมื่อเรดาร์ใช้ไม่ได้ (ความละเอียด 10 กม.) ต้องใส่เครดิต (c)JAXA | https://sharaku.eorc.jaxa.jp/GSMaP/ |
| DWR EWS (`web-service/stn`) | กรมทรัพยากรน้ำ | API (ไม่มีเอกสาร) | กลาง · ทางการ | ฟรี · IP ไทย | ใกล้เวลาจริง | 2,275 สถานี มีสถานะเตือน 4 ระดับ ใช้เมื่อขยายนอก กทม. เท่านั้น | https://ews.dwr.go.th/ews/ |

### 2.2 ปริมาณน้ำในเขื่อน

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| ThaiWater `analyst/dam` (dam_hourly, dam_daily, dam_medium) | สสน. (ข้อมูลจาก กฟผ./ชป.) | API | สูง · ทางการ | ฟรี · cloud ได้ (GitHub Actions สำเร็จ 2026-10-03) | รายชั่วโมง (ล่าช้า 1–2 ชม.) | แหล่งหลักของการ์ดเขื่อน: ปริมาณเก็บกัก น้ำไหลเข้า และน้ำระบาย แปลง MCM/ชม. เป็น m³/s และระบุว่า "หน่วยอนุมาน" ต้องตรวจ `dam_date` ทีละแถว และ `dam_size` ต้องเป็นจำนวนเต็ม | https://api-v3.thaiwater.net/api/v1/thaiwater30/analyst/dam |
| RID reservoir API: `/api/dam/public[/{YYYY-MM-DD}]` (เขื่อนใหญ่), `/api/reservoir/public` (อ่างขนาดกลาง 461 แห่ง) | กรมชลประทาน | API (มีหน้าเอกสาร) | สูง · ทางการ | ฟรี · ยังไม่พิสูจน์ (Deno ต่อ TLS ไม่ได้เพราะรองรับเฉพาะ CBC) ใช้เครื่องในไทยหรือ Node | รายวัน | ตัวเลขทางการ และ backfill ประวัติรายวันได้ ให้แสดงหน่วยน้ำไหลเข้าและน้ำระบายตามค่าดิบ เพราะแต่ละ repo ตีความหน่วยไม่ตรงกัน | https://app.rid.go.th/reservoir/api/document/reservoir |
| data.go.th `big_dams_public` | DGA / กรมชลประทาน | Dataset | สูง | ฟรี (CC-BY) | รายวัน | ใช้เป็นหลักฐานสัญญาอนุญาตบนหน้า "เกี่ยวกับ" และใช้ backfill | https://data.go.th/en/dataset/big_dams_public |
| ThaiWater `public/thailand_main` | สสน. | API | สูง (gie3d ใช้งานบน Vercel) | ฟรี · cloud ได้ | ตาม feed | ทางสำรองของข้อมูลเขื่อนใหญ่ และ URL กล้อง CCTV เขื่อนของ กฟผ. | `api-v3.thaiwater.net/api/v1/thaiwater30/public/thailand_main` |
| EGAT `water_crisis.php` / telemeter schematic | กฟผ. | API (scrape HTML) | กลาง · ทางการ | ฟรี · cloud ได้ | รายวัน / รายชั่วโมง | ใช้ตรวจทานข้อมูลเท่านั้น ข้าม `api-egatwater.../api/dam` เพราะฟิลด์ส่วนใหญ่ว่าง | https://water.egat.co.th/water_crisis.php |

### 2.3 ระดับน้ำแม่น้ำ-คลอง

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| RID SWOC pier API (`get_pier_data?date=&basin=&province=&region=&rid=`) | กรมชลประทาน (SWOC) | API (ไม่มีเอกสาร) | กลาง · ทางการ | ฟรี · ยังไม่พิสูจน์ ใช้เครื่องในไทย | รายชั่วโมง | SourceId ใหม่ `rid-swoc` (StationKind `river`) ใช้ `bankLevel = brae_level_msl` คำนวณ freeboard ได้ทันที มีอัตราการไหล แนวโน้ม 24 ชม. และ C.29A ควรกรองแถวตามฟิลด์ `agency` | https://bigdata-swoc.rid.go.th/api/ma/pier/all/get_pier_data |
| HII FEWS: `rid_discharge/forecast/{C2,C13,C3,C7A,C35}.txt`, `metadata/rid_discharge.csv`, `metadata/hii_waterlevel.csv` | สสน. | API (ไฟล์ static) | สูง · ทางการ | ฟรี · cloud ได้ | ~รายวัน | "การ์ดน้ำเหนือ" (พยากรณ์ 7 วัน) และเกณฑ์ทางการของ 87 สถานี ชป. / 66 สถานี สสน. ไม่ใช้ token ของ api.hii.or.th ที่ฝังอยู่ในเว็บ | https://fews2.hii.or.th/model-output/data_portal |
| ThaiWater `public/flow` | สสน. | API | สูง · ทางการ | ฟรี · cloud ได้ | 10 นาที–รายวัน | อัตราการไหลคลอง กทม. 55 จุด เพิ่มใน adapter `thaiwater` เดิม | `api-v3.thaiwater.net/api/v1/thaiwater30/public/flow` |
| BMA `now.bangkok.go.th` JSON (`canal-water-data.json`, `road-flood-data.json`, `nowcast-data.json`, `cctv-flood-data.json`) + socket `pumps.bangkok.go.th` | สำนักการระบายน้ำ กทม. | API (ไม่มีเอกสาร) | กลาง · ทางการ | ฟรี · IP ไทย | สด / ~5 นาที | เส้นทางที่สองของ `bma-canal`/`bma-roadflood` และสถานะเครื่องสูบแบบสด ต้องขออนุญาต กทม. เหมือน DDS | https://now.bangkok.go.th/ |
| RID SWOC open-data service (`swoc-api-service.rid.go.th/api/{service}`) | กรมชลประทาน | API (มีเอกสาร PDF) | ต่ำ · ยังไม่มีใครเรียกสำเร็จ | ไม่ทราบ | รายชั่วโมง (คาด) | probe เพื่อหา C.29A และขอเงื่อนไขการใช้ ระหว่างนี้ใช้ pier API ไปก่อน | https://bigdata-api.rid.go.th/swoc_opendatadict.pdf |
| DDPM CCTV สถานีวัดระดับน้ำ (ArcGIS FeatureServer + `cctv.disaster.go.th/api/v1/stations/{code}`) | ปภ. | API (ไม่มีเอกสาร) | ต่ำ | ฟรี · ไม่ทราบ (โดเมนหลักอยู่หลัง Cloudflare challenge) | ~5 นาที | probe ครั้งเดียว ถ้ามีสถานีในจังหวัด 10–13 ให้เพิ่มเป็นแหล่งรองพร้อมภาพ CCTV | https://cctv.disaster.go.th/api/v1 |

### 2.4 สภาพอากาศ-พยากรณ์

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| ECMWF Open Data (IFS HRES/ENS, AIFS) ผ่าน Open-Meteo | ECMWF | Dataset | สูง | ฟรี (CC BY 4.0 ตั้งแต่ 2025-10-01 ใช้เชิงพาณิชย์ได้) · cloud ได้ | 2–4 รอบ/วัน | ความน่าจะเป็นฝนหนักเหนือลุ่มต้นน้ำ 1–10 วัน (`models=ecmwf_ifs` + ensemble API) ไม่ต้องทำ pipeline GRIB เอง | https://www.ecmwf.int/en/forecasts/datasets/open-data |
| TMD พยากรณ์ 7 วัน (open-data API) | กรมอุตุฯ | API | สูง · ทางการ | ฟรี ลงทะเบียน | รายวัน | ข้อความพยากรณ์ทางการรายภาค/จังหวัด ใน WeatherCard | https://data.tmd.go.th/api/index1.php |
| TMD HPC riskmap (ดู 2.1) | กรมอุตุฯ | API | กลาง · ทางการ | ฟรี | 2 รอบ/วัน | ฝนหนักรายเขตล่วงหน้า | https://hpc.tmd.go.th/riskmap-district |
| NOAA GFS (ผ่าน Open-Meteo) | NOAA | Dataset | สูง | ฟรี (public domain) | 4 รอบ/วัน | โมเดลที่สองไว้เปรียบเทียบ (ลำดับความสำคัญต่ำ) | https://registry.opendata.aws/noaa-gfs-bdp-pds |
| ERA5/ERA5T | Copernicus C3S | Dataset | สูง | ลงทะเบียนฟรี (CC BY 4.0 ตั้งแต่ 2025-07-02) | รายวัน (ล่าช้า ~5 วัน) | ภูมิอากาศ, return period และ backtest เท่านั้น | https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-timeseries |

ไม่แนะนำในตอนนี้: Tomorrow.io (ฟรี 500 req/วัน และกรมอุตุฯ ยุติการทดลอง PoC แล้ว), OpenWeather, Meteomatics (free tier ใช้เชิงพาณิชย์ไม่ได้), Google WeatherNext (เงื่อนไขทดลองไม่อนุญาตให้แสดงต่อสาธารณะ)

### 2.5 น้ำขึ้นน้ำลง

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| HII FEWS `tide_table/summary.txt` | สสน. | API (ไฟล์ static) | สูง (แหล่ง) · datum ยังไม่ยืนยันว่าเป็น MSL | ฟรี · cloud ได้ | ~รายวัน | ค่าคาดการณ์น้ำขึ้นสูงสุด 28 สถานี ใช้เป็นแหล่งหลักของ "การ์ดน้ำทะเลหนุน" | `https://fews2.hii.or.th/model-output/data_portal/tide_table/summary.txt` |
| หน้า sea level ของ สสน. (`tiwrm.hii.or.th/v3/sealevel`) | สสน. (ข้อมูลกรมอุทกศาสตร์/กรมเจ้าท่า) | API (scrape HTML) | กลาง · ทางการ | ฟรี · cloud ไม่ทราบ (โฮสต์ของ สสน. ปกติเรียกจาก cloud ได้) | รายชั่วโมงหรือถี่กว่า | **ระดับน้ำทะเลที่วัดจริง** ที่ป้อมพระจุลฯ และท่าเรือกรุงเทพ (แหล่งเดียวที่พบ) ใช้คู่กับค่าคาดการณ์ ต้องเขียน parser และขออนุญาต สสน. | https://tiwrm.hii.or.th/v3/sealevel |
| กรมอุทกศาสตร์ กองทัพเรือ (ตารางน้ำ PDF + ประกาศน้ำทะเลหนุน) | กรมอุทกศาสตร์ | ประกาศ/PDF (ไม่มี API) | กลาง · ทางการ | ฟรี · อยู่หลัง Cloudflare challenge ห้าม scrape | รายปี / ตามเหตุการณ์ | กรอกช่วงประกาศน้ำทะเลหนุนเอง (เช่น 29 ก.ย.–4 ต.ค. 2569) เป็นหมายเหตุ "เสี่ยงน้ำทะเลหนุน" ของเขตริมแม่น้ำ | https://hydro.navy.mi.th/ |
| IOC Sea Level Station Monitoring | IOC-UNESCO / VLIZ | API | กลาง | ฟรี (ห้ามใช้เชิงพาณิชย์) | 1–5 นาที | **ใช้ไม่ได้กับ กทม.** มีสถานีไทยเพียงเกาะตะเภาน้อย (อันดามัน) | https://www.ioc-sealevelmonitoring.org/ |

### 2.6 พื้นที่น้ำท่วม

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| GISTDA `api-gateway.gistda.or.th/api/2.0/resources/features/flood/{1day,3days,7days,30days}` | GISTDA | API (มีเอกสาร) | สูง · ทางการ | ลงทะเบียนฟรี (header `API-Key`) · cloud ได้ | รายวัน | ชั้นแผนที่ "น้ำท่วมจากดาวเทียม" ให้ query ด้วย bbox ใช้ชั้นพื้นที่น้ำท่วมซ้ำซาก 2011–2023 เป็นบริบท **ใน กทม. ได้ 0 cell ต้องแสดงว่า "ดาวเทียมมองไม่เห็นน้ำในเมือง"** | https://opendata.gistda.or.th/en/dataset/disasters-01 |
| Copernicus GFM (STAC) | Copernicus EMS / EODC | API | สูง | ฟรี ไม่ต้องใช้ key (CC BY 4.0) · cloud ได้ | ตามรอบ Sentinel-1 (~7 ชม. หลังดาวเทียมผ่าน) | ชั้นที่สองสำหรับจังหวัดริมเจ้าพระยา (อยุธยา ปทุมธานีตอนเหนือ อ่างทอง) แสดงเฉพาะ "เห็นว่าท่วม" ห้ามแสดงว่า "แห้ง" | https://stac.eodc.eu/api/v1/collections/GFM/items |
| Longdo/iTIC traffic events | Metamedia (Longdo) / iTIC / กรมทางหลวง | Commercial API (feed ฟรี) | สูง | ฟรี · cloud ได้ | ระดับนาที | ชั้นแผนที่ "รายงานถนนน้ำท่วม" จากผู้ใช้ เสริมเซนเซอร์ กทม. ต้องขออนุญาตและใส่เครดิต Longdo/iTIC | https://event.longdo.com/feed/json |
| data.go.th `ced48` (พื้นที่เสี่ยง กทม. 2568) / data.bangkok.go.th (CKAN) | กทม. / DGA | Dataset | กลาง · ทางการ | ฟรี | รายปี | ชั้นข้อมูลถาวร: จุดเสี่ยงน้ำท่วม สถานีสูบ และตำแหน่ง CCTV โหลดปีละครั้ง | https://data.go.th/en/dataset/ced48 · https://data.bangkok.go.th/ |
| NASA GIBS MODIS Combined Flood 2-Day | NASA | Dataset | สูง (บริการ) · มองไม่เห็นใต้เมฆมรสุม | ฟรี · cloud ได้ | รายวัน | ลำดับความสำคัญต่ำ เป็นภาพหยาบ | https://nasa-gibs.github.io/gibs-api-docs/ |
| Sentinel Asia / Copernicus EMS Rapid Mapping | APRSAF-JAXA / EC | แผนที่ตามเหตุการณ์ | กลาง | ฟรี (เปิดใช้งานผ่านหน่วยงานสมาชิกเท่านั้น) | ตามคำขอ | ใส่ลิงก์อ้างอิงเมื่อมี activation ในไทย | https://sentinel-asia.org/ |

### 2.7 ประกาศเตือนภัยทางการ

| แหล่ง | หน่วยงาน | ประเภท | ความน่าเชื่อถือ | การเข้าถึง | ความถี่ | ใช้กับระบบเราอย่างไร | ลิงก์ |
|---|---|---|---|---|---|---|---|
| TMD CAP 1.2 (TH และ EN `/en/api/xml/CAP`) | กรมอุตุฯ (WMO alerting authority) | API (RSS + CAP XML) | สูง · ทางการ | ฟรี · cloud ได้ (ต้องเพิ่ม GlobalSign GCC R6 AlphaSSL CA 2025 ผ่าน `NODE_EXTRA_CA_CERTS`) | ตามเหตุการณ์ (poll ทุก 15 นาที) | แบนเนอร์ "ประกาศกรมอุตุฯ" กรองตาม `expires` และ `references` (Update/Cancel) แล้วจับคู่ `TH-10..13` | https://www.tmd.go.th/api/xml/CAP |
| TMD WeatherWarningNews v2 | กรมอุตุฯ | API | สูง · ทางการ | ฟรี ลงทะเบียน uid/ukey | ตามเหตุการณ์ | ข้อความฉบับเต็มและ PDF เป็นทางสำรองของ CAP (ห้ามใช้ v1 เพราะค้างตั้งแต่ปี 2022) | https://data.tmd.go.th/api/index1.php |
| Google Weather `publicAlerts:lookup` | Google (ผู้ให้ข้อมูลไทยคือกรมอุตุฯ) | Commercial API | กลาง · ยังไม่ทดสอบกับจุดในไทย | ต้องมี key และ billing · ฟรี 10,000 events/เดือน · cloud ได้ | ใกล้เวลาจริง | สำเนาสำรองของประกาศกรมอุตุฯ เมื่อเรียก tmd.go.th ไม่ได้ ต้องแสดงว่ากรมอุตุฯ เป็นผู้ออกประกาศ และถ้าได้ 404 ไม่ได้แปลว่าไม่มีประกาศ | https://developers.google.com/maps/documentation/weather/weather-alerts |
| HII FEWS `flashflood/flashflood_report.txt` (FFPI) | สสน. | API (ไฟล์) | สูง · ทางการ | ฟรี · cloud ได้ | รายวัน | ตำบลเสี่ยงน้ำป่าไหลหลาก ใช้เมื่อขยายนอก กทม. | https://fews2.hii.or.th/model-output/data_portal |
| DDPM (เว็บไซต์, แอป THAI DISASTER ALERT, Cell Broadcast) | ปภ. | ไม่มี feed ที่เครื่องอ่านได้ | ทางการ | อยู่หลัง Cloudflare challenge | ตามเหตุการณ์ | ใส่เป็นลิงก์และสายด่วน 1784 เท่านั้น ห้าม bypass Cloudflare | https://www.disaster.go.th/home |
| Google Flood Forecasting API (Flood Hub) | Google Research | Official API (pilot) | สูง (ข้อเท็จจริง) · ไม่ได้ทำให้การพยากรณ์ดีขึ้นในแม่น้ำที่มีเขื่อน | ฟรี ต้องเข้า waitlist + key · ใช้ได้เฉพาะงานไม่เชิงพาณิชย์ | รายวัน | สมัครไว้ แสดงสถานะ virtual gauge เจ้าพระยาเป็น "โมเดล Google" ไว้เทียบเท่านั้น | https://developers.google.com/flood-forecasting |
| GDACS (RSS/API, MCP `org.gdacs/api`) | EC JRC / UN OCHA | Open dataset | สูง | ฟรี · cloud ได้ | ตามเหตุการณ์ | บริบทพายุหมุนเขตร้อนเท่านั้น (ไม่มีเหตุการณ์น้ำท่วมไทยเลยในปี 2026) | https://www.gdacs.org/xml/rss.xml |

---

## 3) MCP connectors และ skills ที่ใช้กับ Claude ได้ทันที

**ข้อสรุป:** ใน MCP registry ทางการและไดเรกทอรีของ claude.ai ไม่มี MCP ใดครอบคลุม ThaiWater/HII, RID, EGAT, GISTDA หรือข้อมูลน้ำขึ้นน้ำลงของกองทัพเรือ
(ค้นคำว่า "thai" ได้ 18 server ไม่มีตัวไหนเกี่ยวกับน้ำหรืออากาศ ส่วน "popnix" ได้ 0) ด้านอากาศ ไดเรกทอรีของ claude.ai มีเพียง AccuWeather และ Xweather

### 3.1 ใช้ได้ทันที (สำหรับผู้ใช้ Claude, analyst และนักพัฒนา ไม่ใช่สำหรับ ingest)

| ชื่อ | ประเภท | ข้อมูล | Auth/ค่าใช้จ่าย | วิธีใช้ / หมายเหตุ |
|---|---|---|---|---|
| **POPNIX Flood MCP** (`https://flood.pop.in.th/api_mcp.php`) | MCP remote (Streamable HTTP) | คลอง กทม. ~200 จุด ถนน/อุโมงค์ ฝน และแม่น้ำเจ้าพระยา (ข้อมูลทวนจาก สนน.) | ฟรี ไม่ต้องใช้ key · 30 req/นาที/IP · ขนาด request ≤16 KB | `claude mcp add --transport http popnix-flood https://flood.pop.in.th/api_mcp.php` เหมาะกับการถามตอบเรื่องคลอง กทม. ข้อมูลมาจากผู้เผยแพร่ซ้ำ (community) ไม่อยู่ใน registry และชื่อ tool ยังไม่ยืนยัน |
| **gain9999/thaiwater** | Claude Code slash commands (15 ไฟล์ ไม่ใช่ SKILL.md) | ThaiWater, TMD, DDS กทม., RID WMSC, EGAT, GISTDA, ONWR, DDPM, DWR EWS, ตารางน้ำกองทัพเรือ, Google Flood Hub, ECMWF | ฟรี (TMD และ Google ต้องใช้ key) | เป็นแคตตาล็อก endpoint ไทยที่ดีที่สุด ใช้ส่วนตัวใน `~/.claude/commands` **ห้าม commit เข้า repo หรือแจกต่อ** เพราะไม่มี LICENSE ถ้าจะใช้ในทีมต้องขออนุญาตผู้เขียนก่อน และห้ามใช้ token ของ HII ที่ฝังอยู่ในไฟล์ |
| **weather-mcp** (`@dangahagan/weather-mcp`) | MCP stdio (npm) | Open-Meteo, METAR, marine, เรดาร์, ฟ้าผ่า, แม่น้ำ (GloFAS) รวม 17 tool | ฟรี (ประกาศเตือนของไทยต้องใช้ `GOOGLE_WEATHER_API_KEY`) | MIT และ active มาก (เวอร์ชัน 1.34.3, 3 ต.ค. 2569) ตั้ง `ENABLED_TOOLS=all` ควรนำข้อความ "ไม่มีประกาศ ≠ ปลอดภัย" มาใช้ใน UI ของเรา |
| **open-meteo-mcp** (cmer81) | MCP stdio (npm) | forecast, ensemble, GloFAS, ERA5, marine | ฟรี (ไม่เชิงพาณิชย์) | MIT ใช้ตรวจ GloFAS และ ensemble คู่กับ adapter Open-Meteo ของเรา |
| **GDACS official MCP** (`https://api.gdacs.org/mcp`) | MCP remote | เหตุภัยพิบัติโลก (พายุ แผ่นดินไหว น้ำท่วม) | ไม่ต้องใช้ key | อยู่ใน registry ทางการ (`org.gdacs/api`) และใช้แทน wrapper ของ Pipeworx ได้ ยังไม่เห็นรายชื่อ tool |
| **NASA Earthdata MCP** (`https://cmr.earthdata.nasa.gov/mcp/v1`) | MCP remote (ทางการ) | ค้นหาชุดข้อมูล IMERG, MODIS/VIIRS flood และ SAR | ฟรี | ใช้ค้นหาเท่านั้น ดาวน์โหลดผ่าน earthaccess เหมาะกับงานวิจัยและ backfill |
| **copernicus-mcp** (CliDyn) | MCP (pip) | GloFAS, EFAS, ERA5, Copernicus Marine | ลงทะเบียน CDS ฟรี | BSD-3 ใช้ backfill ข้อมูลย้อนหลังลุ่มเจ้าพระยา ไม่ใช่ข้อมูลเวลาจริง |
| **ReliefWeb MCP** (cyanheads) | MCP stdio / hosted | รายงานสถานการณ์และประวัติภัยพิบัติ (THA) | ต้องมี appname ที่ได้รับอนุมัติ | Apache-2.0 |
| **AccuWeather** (ไดเรกทอรี claude.ai) | Connector | พยากรณ์ และ MinuteCast (บางพื้นที่) | ไม่ต้อง sign-in | ส่งกลับเป็น widget ใช้ในแชตเท่านั้น ยังไม่ยืนยันว่า Government Alerts รวมประกาศของกรมอุตุฯ |
| **Google Maps Grounding Lite** (`https://mapstools.googleapis.com/mcp`) | MCP remote | `lookup_weather` (ปัจจุบัน รายชั่วโมง รายวัน) | ต้องใช้ API key · ฟรีระหว่างช่วง Experimental | เรียกจาก sandbox ได้จริง ใช้ในแชตเท่านั้น ไม่มี tool ประกาศเตือน |

**ไม่แนะนำ:** zartre/tmd-mcp-server (พิมพ์ `TMD_API_KEY` ลง stderr ที่ `src/tmdClient.ts:35`), Peemwsr/tmd-weather-mcp (มีแค่ข้อมูลรายวัน), Thinaakar/TH-MCP (คำเตือนของมันมาจาก weather code ของ Open-Meteo ไม่ใช่ประกาศกรมอุตุฯ), arnfa-mcp, Pipeworx (มี GDACS ทางการแทนแล้ว), Xweather (ไม่มีประกาศของไทย) และ MCP เชิงพาณิชย์อื่น ๆ (Tomorrow.io, OpenWeather, Meteomatics, WWO, Windborne) เพราะไม่มีข้อมูลทางการของไทยเพิ่ม

### 3.2 ควรสร้างเอง

1. **`flood-monitor` MCP (remote, อ่านอย่างเดียว)** ให้บริการข้อมูลที่ normalize แล้ว (`Station`/`Reading`/`SourceHealth`) จาก API ของเรา (`/api/snapshot`, `/api/stations`, `/api/history`) จะเป็นรายการแรกใน registry ที่ครอบคลุม BMA, ThaiWater และ RID
   tools ที่เสนอ: `get_situation(district?)`, `list_stations(kind, level)`, `get_station_history(id, hours)`, `get_dams()`, `get_upstream_outlook()`, `get_official_warnings()`, `get_source_health()`
   ใช้ skill `anthropic-skills:mcp-builder` สร้างโครง และใช้ hithereiamaliff/mcp-datagovmy (MIT, มี `get_flood_warnings`) เป็นต้นแบบการออกแบบ ทุกคำตอบต้องมีข้อมูลที่มา (attribution) และเวลาที่สังเกต (`observedAt`)
2. **ThaiWater MCP** (wrapper บาง ๆ ครอบ `api-v3` public: `waterlevel_load`, `rain_24h`, `provinces/rain3d`, `analyst/dam`, `public/flow`, `thailand_main` และ fews2) ใช้ภายในทีมได้ทันที แต่ถ้าจะเปิด host สาธารณะต้องขออนุญาต สสน. ก่อน ต้อง serialize request และห้ามส่ง Referer
3. **Project skill `thai-water-sources`** (SKILL.md ใน repo) รวมสูตร endpoint และข้อควรระวังจาก `docs/DATA-SOURCES.md` และรายงานนี้ (หน่วย เวลา datum ข้อจำกัด IP) ให้ agent ใช้ตอนเพิ่ม adapter ต้องเขียนเอง ห้ามคัดลอกจาก gain9999

---

## 4) GitHub repositories ที่ควรศึกษาหรืออ้างอิง

**กติกา:** repo ที่ไม่มีไฟล์ LICENSE ถือว่าสงวนลิขสิทธิ์ทั้งหมด ใช้เป็นข้อมูลอ้างอิงแบบอ่านอย่างเดียว ห้ามคัดลอกโค้ด ส่วน MIT/Apache/BSD นำโค้ดมาปรับใช้ได้โดยต้องคงข้อความลิขสิทธิ์ไว้

### 4.1 นำโค้ดมาใช้ได้ (มีสัญญาอนุญาต)

| Repo | License | ใช้ทำอะไร |
|---|---|---|
| https://github.com/flukelaster/SIAHRA | MIT | **parser ของ HII FEWS discharge forecast และรายการเรดาร์ TMD พร้อม fixture จริง** (`apps/api/src/ingestion/hiiFews.ts`, `tmdRadar.ts`) |
| https://github.com/icyice1998/Flood | MIT | parser ของ Longdo events/CCTV และ GDACS; health JSON ต่อแหล่ง; หลักฐานว่า `thaiwater-canal` ค้าง; บทเรียนเรื่อง 429 ของ ThaiWater (ห้ามส่ง Referer ต่างประเทศ) |
| https://github.com/bejranonda/flood2026 | MIT | log การ probe จากเยอรมนี (`research/VALIDATION_2026-09-27_nationwide.md`) ผล backtest GloFAS และงานวิจัยดาวเทียม (GFM/GISTDA) |
| https://github.com/weather-mcp/weather-mcp | MIT | ตัวอย่างการจัดการ Google Weather alerts (ฟิลด์ที่ไม่ตรงเอกสาร) และข้อความ "absence ≠ all-clear" |
| https://github.com/cmer81/open-meteo-mcp | MIT | MCP ของ Open-Meteo |
| dynamical-org/reformatters (clone ใน refs3) | BSD-3 (โค้ด), CC-BY-4.0 (ข้อมูล) | ข้อมูล IMERG/CHIRPS/ECMWF แบบ Zarr ไม่ต้องใช้ key |
| https://github.com/ghiggi/gpm_api | MIT | ไคลเอนต์ IMERG NRT (ถ้าจะทำ worker ด้วย Python) |
| https://github.com/CliDyn/copernicus-mcp | BSD-3 | ดึง GloFAS/ERA5 |
| https://github.com/PMFrancisco/geohazard-mcp | Apache-2.0 | ตัวอย่าง query GDACS ตามพื้นที่ (404 = ไม่มีเหตุการณ์) |
| https://github.com/cyanheads/reliefweb-mcp-server · https://github.com/cyanheads/earthquake-mcp-server | Apache-2.0 | MCP ของรายงานภัยพิบัติและแผ่นดินไหว |
| https://github.com/hithereiamaliff/mcp-datagovmy | MIT | ต้นแบบการออกแบบ flood MCP ระดับประเทศ |
| https://github.com/asiripanich/thaigov | MIT (2022, เก่า) | ตัวอย่างการเรียก CKAN ของ data.go.th |
| https://github.com/JoshuaKimsey/LibreWXR | **AGPL-3.0** | ทางเลือกถ้า RainViewer ปิด (copyleft เข้ม ใช้แบบ self-host แยก service เท่านั้น) |

### 4.2 อ่านเพื่ออ้างอิงเท่านั้น (ไม่มี LICENSE)

| Repo | อัปเดตล่าสุด | สิ่งที่ควรเรียนรู้ |
|---|---|---|
| https://github.com/gie3d/bkk-flood | 2026-10-03 | โครงการ กทม. ที่ใกล้ที่สุด: **ความสูงเขื่อนป้องกันน้ำท่วมของ กทม. ริมเจ้าพระยาแต่ละช่วง** (+3.50 / +3.25 / +3.00 / +2.80 ม.รทก.), การใช้ `thailand_main`, ThaiWater ไม่มี C.29A (เกณฑ์ C.13 ของ repo นี้ตั้งเอง ห้ามใช้) |
| https://github.com/usmanwaji/waterchaidantai | 2026-10-02 | สูตรเรียก TMD riskmap, ONWR WAM และ DDPM CCTV ผ่าน Worker proxy (ยังไม่มีการทดสอบจากฝั่งเรา) |
| https://github.com/ipunn/maeklong-photharam-watch | 2026-10-03 | พิสูจน์ว่า ThaiWater dam/graph และ EGAT เรียกจาก GitHub Actions ได้ มีบันทึกเรื่องหน่วยและ timezone และหน้า sea level ของ สสน. |
| https://github.com/akachaisen/waterwest | 2026-10-03 | ชื่อฟิลด์ของ RID SWOC และ EGAT รวมถึงปัญหา TLS CBC กับ Deno |
| https://github.com/telnutella/doonam-official-collector | 2026-09-27 | ตัวเก็บ TMD CAP พร้อม cert GlobalSign และการติดป้ายสัญญาอนุญาตต่อแหล่ง |
| https://github.com/SunThanawit/thai-flood-watch · https://github.com/GoBobob/siriplace52 | 2026-09-29 / 10-02 | JSON ของ now.bangkok.go.th, socket เครื่องสูบ และสถาปัตยกรรม relay ในไทย |
| https://github.com/tangpadon/Thai-Dam-Classification-Project | 2026-10-01 | `/api/dam/public/{date}` (กรณีข้อมูลวันนี้ยังไม่ออกให้ใช้ของเมื่อวาน) |
| https://github.com/tnksatthai-hub/nam-thueng-nai | 2026-09-26 | RID SWOC pier และ hyd-app-db |
| https://github.com/Srisuphadith/reservior_visualize_ver-0.0.2 | 2026-10-03 | fixture จริงของ RID reservoir (2026-10-03) |
| https://github.com/m0ndez/flood-aware | 2026-10-02 | TMD RADARGIS (`valid_dt_ts` คลาด 7 ชม.) และ TMD API บน Vercel sin1 |
| https://github.com/OCHA-DAP/ds-google-flood-hub | 2026-09-24 | พฤติกรรมจริงของ Google Flood API (ทางเลือกที่มีสัญญาอนุญาตคือ abhiramm7/openfloodhub, Apache-2.0) |
| https://github.com/pnoch/R.AI.N.TH | 2026-09-24 | รูปแบบไฟล์ TMD composite และความเสี่ยงด้านสัญญาอนุญาตของ RainViewer (ระบุ MIT เฉพาะใน package.json จึงยังถือว่าไม่ชัดเจน ต้องขออนุญาตก่อน) |
| https://github.com/oadtz/waterways · https://github.com/NgNguyenChuong/Mekong-Synchonization · https://github.com/fault2004/tmd-weather-bash · https://github.com/nattaponm/RadarRainfallMosaic-TH | – | ใช้เป็นแนวคิดเท่านั้น / Mekong / XML พายุของ TMD (ยังไม่ยืนยันว่าใช้ได้ในปี 2026) / งานวิชาการ |
| https://github.com/xuantinhsea/thai-hydro-watch | 2026-10-04 (JST) | **มีลิขสิทธิ์ (Nippon Koei)** ใช้ได้เฉพาะข้อเท็จจริง เช่น ThaiWater เก็บฝนรายชั่วโมงไว้แค่ตั้งแต่ 00:00 ของเมื่อวาน เราจึงต้องเก็บ archive เอง |

---

## 5) แผนเพิ่มเข้าระบบ

หมายเหตุเรื่องสถาปัตยกรรม:
- **ระดับน้ำแม่น้ำ** (`rid-swoc`) ใช้ `Station`/`Reading` และ engine freeboard เดิมได้เลย
- **เขื่อน น้ำเหนือ น้ำทะเล ฝนพยากรณ์ และประกาศ** ไม่เข้ากับ freeboard จึงควรเป็น "context feed" แยก (แบบเดียวกับ `weather-cache.ts`) และต้องเพิ่ม contract ใน `src/lib/types.ts` และ `src/lib/server/public.ts` โดยอ่าน `docs/DESIGN.md` ก่อน
- ทุก adapter ต้องรับ `fetch`/`sleep` แบบ inject ได้ ใช้ fixture จริงใน `tests/fixtures/` ตั้ง `thaiIpOnly` ให้ถูกต้อง และแสดงที่มาของข้อมูลในหน้า "เกี่ยวกับ"

ขนาดงาน: S ≤ 1 วัน · M 2–4 วัน · L ≥ 1 สัปดาห์

### P1: ทำทันที (ได้ประโยชน์สูง และส่วนใหญ่เรียกจาก cloud ได้)

| # | งาน | Endpoint | SourceId | UI | ขนาด | เงื่อนไข |
|---|---|---|---|---|---|---|
| 1 | Alarm แจ้งเมื่อข้อมูลค้าง | ใช้ `SourceHealth.latestObservationAt` ที่มีอยู่แล้ว | (ทุกแหล่ง โดยเฉพาะ `thaiwater-canal`) | แบนเนอร์ผู้ดูแลและ `/api/health` แจ้ง `stale` เมื่อเกิน 3 ชม. | S | `thaiwater-canal` ค้างตั้งแต่ 28 ก.ย. 13:30 |
| 2 | ประกาศเตือนภัยกรมอุตุฯ | `GET https://www.tmd.go.th/api/xml/CAP` แล้วตามไปที่ `uploads/CAP/CAPTMD*.xml` | `tmd-cap` | **แบนเนอร์ "ประกาศกรมอุตุฯ"** (ระดับความรุนแรง ช่วงเวลามีผล พื้นที่ TH-10..13) แยกจากสถานะของเรา | S | bundle cert GlobalSign (หมดอายุ 2027-05-21) กรอง `expires` และ Cancel |
| 3 | น้ำเหนือและเกณฑ์ทางการ | `fews2.hii.or.th/model-output/data_portal/rid_discharge/forecast/{C2,C13,C35}.txt` และ `metadata/rid_discharge.csv` | `hii-fews` | **"การ์ดน้ำเหนือ"**: Q ปัจจุบัน + กราฟพยากรณ์ 7 วัน ที่ C.2 นครสวรรค์ / C.13 ท้ายเขื่อนเจ้าพระยา พร้อมเส้นเกณฑ์ 3 ระดับ | M | ปรับ parser จาก SIAHRA (MIT) แสดงเวลาเป็นเวลาไทย |
| 4 | เขื่อนหลักลุ่มเจ้าพระยา | `api-v3.thaiwater.net/.../analyst/dam?dam_size=1` (รายชั่วโมง, cloud) + `app.rid.go.th/reservoir/api/dam/public/{date}` (รายวันทางการ ผ่านเครื่องในไทย) | `thaiwater-dam`, `rid-dam` | **"การ์ดเขื่อนหลักลุ่มเจ้าพระยา"**: ภูมิพล สิริกิติ์ แควน้อยฯ ป่าสักฯ แสดง % ความจุ น้ำไหลเข้า น้ำระบาย (m³/s) และแนวโน้ม 7 วัน | M | ระบุว่าหน่วยรายชั่วโมงเป็นค่าอนุมาน ตรวจ `dam_date` ทีละแถว ใส่เครดิต RID CC-BY |
| 5 | สถานีแม่น้ำ RID เทียบตลิ่ง | `bigdata-swoc.rid.go.th/api/ma/pier/all/get_pier_data?date=&basin=&province=&region=&rid=` | `rid-swoc` (StationKind `river`) | จุดบนแผนที่ + GaugeGrid; เพิ่ม C.29A บางไทร, C.13, C.3 และ C.35 ใน "การ์ดน้ำเหนือ" | M | **probe จากเครื่องในไทยและ cloud ก่อน** ตั้ง `thaiIpOnly: true` จนกว่าจะพิสูจน์ได้ กรองตาม `agency` ขออนุญาต RID |

### P2: ทำถัดไป (ได้ประโยชน์สูง แต่ต้อง probe หรือเขียน parser ก่อน)

| # | งาน | Endpoint | SourceId | UI | ขนาด | เงื่อนไข |
|---|---|---|---|---|---|---|
| 6 | น้ำทะเลหนุน | `fews2.../tide_table/summary.txt` (คาดการณ์) + scrape `tiwrm.hii.or.th/v3/sealevel` (ค่าวัดจริงที่ป้อมพระจุลฯ/ท่าเรือกรุงเทพ) + ประกาศกรมอุทกศาสตร์ที่ผู้ดูแลกรอกเอง | `hii-tide` | **"การ์ดน้ำทะเลหนุน"**: ระดับสูงสุดวันนี้และพรุ่งนี้ + ค่าวัดจริงเทียบค่าคาดการณ์ + เปรียบกับความสูงเขื่อนริมเจ้าพระยา (+2.80 ถึง +3.50 ม.รทก.) + คำเตือน "น้ำทะเลหนุน + น้ำเหนือ" | M | datum ของค่าคาดการณ์ยังไม่ยืนยันว่าเป็น MSL ต้องขออนุญาต สสน. ก่อน scrape |
| 7 | Nowcast ฝน 3 ชม. รายเขต | `wam.onwr.go.th/api/zones?level=district` (+ `/api/frames`) | `onwr-wam` | **"การ์ดฝน 3 ชม. ข้างหน้า"** ต่อเขตที่ผู้ใช้เลือก และเพิ่มเป็นสัญญาณล่วงหน้าในการแจ้งเตือน | M | probe ทั้งสองโฮสต์ ไฟล์ ~8.7 MB ต้อง cache และขออนุญาต สทนช. |
| 8 | ฝนพยากรณ์รายเขตจากกรมอุตุฯ | `hpc.tmd.go.th/static/images/riskmap_json/rain.YYYYMMDD.{0000\|1200}.json` | `tmd-riskmap` | แถว "ฝนพรุ่งนี้ (กรมอุตุฯ)" ใน WeatherCard ใช้เกณฑ์ 35/65/125/250 มม. | S | ตรวจก่อนว่ามีครบ 50 เขตของ กทม. |
| 9 | เรดาร์ทางการแทน RainViewer | `weather.tmd.go.th/composite/images_composite.list` + PNG ใน `composite/images/zr/` | `tmd-radar` | RadarCard/RadarMap แสดงเรดาร์กรมอุตุฯ คู่กับ frame nowcast ของ WAM | M | บาง frame ได้ 404 ต้องอ่าน disclaimer ของ TMD และเก็บ RainViewer ไว้เป็นทางสำรอง |
| 10 | เส้นทางที่สองของ กทม. และเครื่องสูบแบบสด | `now.bangkok.go.th/*.json` + `wss://pumps.bangkok.go.th` (namespace `/iot/devices`) | `bma-now` | สถานะเครื่องสูบแบบสดใน popup และ fallback เมื่อ DDS ล่ม | M | ใช้ IP ไทยเท่านั้น ต้องได้อนุญาตจาก กทม. |
| 11 | รายงานถนนน้ำท่วมจากผู้ใช้ | `event.longdo.com/feed/json` | `longdo-events` | ชั้นแผนที่ "รายงานถนนน้ำท่วม (Longdo/iTIC)" แยกสีจากเซนเซอร์ | S | ขออนุญาต Longdo ปรับ parser จาก icyice1998 (MIT) |
| 12 | อัตราการไหลคลอง กทม. + ฝนสะสมหลายวัน | `thaiwater30/public/flow`, `provinces/rain3d` | (ขยาย adapter `thaiwater`) | แสดง Q ใน StationPopup และฝน 3 วันใน RainGaugeCard | S | เพิ่ม schema canary test เพราะ ThaiWater เพิ่ง relaunch เมื่อ 17 ก.ค. 2569 |

### P3: ภายหลัง หรือเมื่อขยายพื้นที่

| # | งาน | Endpoint | SourceId | UI | ขนาด |
|---|---|---|---|---|---|
| 13 | น้ำท่วมจากดาวเทียม | GISTDA `api-gateway.../features/flood/{1day,3days,7days}` (ใช้ bbox) + Copernicus GFM STAC | `gistda-flood`, `copernicus-gfm` | ชั้นแผนที่ "พื้นที่น้ำท่วมจากดาวเทียม (ปริมณฑล/ริมเจ้าพระยา)" พร้อมคำเตือนว่ามองไม่เห็นน้ำในเมือง | M |
| 14 | `flood-monitor` MCP | API ของเราเอง | – | ใช้ผ่าน Claude / ลงทะเบียนใน registry | M |
| 15 | สำเนาสำรองของประกาศ | Google Weather `publicAlerts:lookup` | `google-alerts` | ใช้กับแบนเนอร์เดิม (ระบุว่ากรมอุตุฯ เป็นผู้ออก) | S |
| 16 | สมัคร Google Flood Hub | waitlist → `floodforecasting` API | `google-floodhub` | แสดงบนการ์ดน้ำเหนือเป็นค่าโมเดลไว้เทียบเท่านั้น | S |
| 17 | ชั้นข้อมูลถาวรของ กทม. | data.go.th `ced48`, data.bangkok.go.th (สถานีสูบ, CCTV) | (static) | ชั้น "จุดเสี่ยงน้ำท่วม กทม." | S |
| 18 | ฝนลุ่มต้นน้ำจากดาวเทียม | IMERG Early (dynamical.org Zarr) / GSMaP | `imerg-basin` | ฝนสะสม 72 ชม. ของลุ่มปิง วัง ยม น่าน และป่าสัก บนการ์ดน้ำเหนือ | M |
| 19 | ขยายระดับประเทศ | DWR EWS, HII FFPI, DDPM CCTV, MRC | `dwr-ews` ฯลฯ | หน้าแยกสำหรับต่างจังหวัด | L |

---

## 6) ข้อควรระวัง

**เงื่อนไขการใช้และการอ้างอิงที่มา**
- API ไทยส่วนใหญ่ **ไม่มีเอกสารและไม่ได้ประกาศเงื่อนไขการใช้** (RID SWOC, WAM, TMD HPC, DDPM, BMA now) ต้องขออนุญาตก่อนเปิดบริการสาธารณะ: สสน. (info_thaiwater@hii.or.th), กรมชลประทาน, กรมอุตุฯ, สทนช., ปภ., กทม. และ Longdo
- สัญญาอนุญาตที่ยืนยันแล้ว:
  - RID เขื่อนใหญ่ (data.go.th `big_dams_public`): CC-BY
  - Open-Meteo, ECMWF real-time (ตั้งแต่ 2025-10-01), GloFAS/ERA5 (ตั้งแต่ 2025-07-02) และ Copernicus GFM: CC BY 4.0
  - GISTDA: Open Data Common
  - GSMaP: ใช้เชิงพาณิชย์ได้ แต่ต้องใส่เครดิต (c)JAXA
- เงื่อนไขที่จำกัด:
  - Google Flood Hub: ข้อมูลเป็น CC BY 4.0 แต่ใช้ได้เฉพาะงานไม่เชิงพาณิชย์
  - IOC sea level: ห้ามใช้เชิงพาณิชย์
  - **RainViewer: ตั้งแต่ 1 ม.ค. 2569 ใช้ได้เฉพาะส่วนบุคคลหรือการศึกษา** ซึ่งการใช้แบบเปิดสาธารณะของเราเสี่ยงผิดเงื่อนไข
  - WeatherNext: เป็นเงื่อนไขทดลอง และห้ามแสดงค่าต่อสาธารณะ
- ยังไม่ยืนยัน: อ่างขนาดกลาง "Open Data Common", iTIC CC BY 4.0 ครอบคลุม feed ของ Longdo หรือไม่ (ข้อมูลทั้งสองข้อได้มาจาก README ของ doonam เท่านั้น)
- ต้องแสดง **"ระบบนี้ไม่ใช่ประกาศเตือนภัยทางการ"** ต่อไป และแยกประกาศทางการ (TMD CAP, ประกาศน้ำทะเลหนุนของกองทัพเรือ) ออกจากสถานะ freeboard ของเราให้ชัด

**Geo-blocking และ TLS**
- ใช้ได้เฉพาะ IP ไทย: `*.bangkok.go.th` (รวม now/pumps), DWR EWS, RID telerid, ONWR ntw-admin
- อยู่หลัง Cloudflare challenge: กรมอุทกศาสตร์ และ disaster.go.th (ห้าม bypass challenge)
- ยังไม่พิสูจน์ว่าเรียกจาก cloud ได้: `app.rid.go.th`, `bigdata-swoc.rid.go.th`, WAM, TMD HPC, TMD composite และ DDPM CCTV
  - หลักฐานจาก Cloudflare Worker **พิสูจน์ไม่ได้** ว่าเรียกจาก cloud ต่างประเทศได้ เพราะ Worker รันที่ PoP ใกล้ผู้เรียก (ซึ่งอาจอยู่ในไทย)
- เรียกจาก cloud ได้แน่นอน: ThaiWater api-v3, fews2, EGAT, GISTDA (มี key), TMD CAP (เมื่อเพิ่ม cert), Longdo, GDACS, Open-Meteo, NASA, ECMWF และ GFM
- `app.rid.go.th` รองรับเฉพาะ cipher CBC: Deno/Supabase ต่อไม่ได้ ให้ใช้ Node/OpenSSL
- `www.tmd.go.th` ส่ง certificate chain ไม่ครบ: ให้เพิ่ม intermediate ผ่าน `NODE_EXTRA_CA_CERTS` **ห้ามปิด TLS verification**

**Rate limit**
- ThaiWater: ตอบ 429 เมื่อยิงถี่หรือมี Referer ต่างประเทศ ให้ยิงทีละ request และใช้ backoff ที่มีอยู่แล้ว
- POPNIX: 30 req/นาที/IP และขนาด request ≤16 KB
- RainViewer: 100 req/นาที/IP
- Google Flood API: 200 req/นาที
- Google Weather: ฟรี 10,000 events/เดือน
- Open-Meteo flood: ตอบ 429 เมื่อขอ 49 จุด × 1 ปี ในครั้งเดียว
- GISTDA: ดึงทั้งประเทศ 7 วันได้ 111,387 cells (23 หน้า ~7 นาที) จึงต้องใช้ bbox
- WAM zones: ~8.7 MB ต่อครั้ง ต้อง cache

**ห้ามทำ**
- ห้ามใช้ token หรือ key ที่ฝังอยู่ในเว็บหรือ repo ของคนอื่น: token ของ api.hii.or.th ใน gain9999 และ waterchaidantai, token GSMaP ของ HII, key ของหน้าเว็บ Flood Hub
- ห้ามปลอม Origin/Referer เพื่อเรียก RID hyd-app-db
- ห้ามคัดลอกโค้ดจาก repo ที่ไม่มี LICENSE

**ความผิดปกติของข้อมูล**
- หน่วยและ datum:
  - `dam_hourly`: หน่วย MCM/ชม. เป็นค่าที่อนุมานเอง
  - น้ำไหลเข้า/ระบายของ RID: แต่ละ repo ตีความหน่วยขัดกัน
  - ค่าคาดการณ์น้ำขึ้นน้ำลงของ HII: ยังไม่ยืนยันว่า datum เป็น MSL
  - `waterlevelvalue` ของ hyd-app-db: เทียบกับ gauge ไม่ใช่ MSL
- เวลา:
  - `dam_date`: เป็นเวลาไทยที่ไม่ระบุ timezone
  - `valid_dt_ts` ของ RADARGIS: คลาดไป 7 ชม.
  - DWR: ใช้ปี พ.ศ. แบบย่อ
- สถานะและแถวข้อมูล:
  - DWR: สถานะ 9 (783 สถานี) ไม่มีในเอกสาร
  - SWOC pier: มีแถวของหน่วยงานอื่นปนอยู่
  - TMD CAP: RSS ยังเก็บประกาศที่หมดอายุไว้
- การตีความค่าว่าง:
  - ดาวเทียม (GISTDA ได้ 0 cell ใน กทม.; GFM ถูก mask 71% ของใจกลาง กทม.) ไม่เห็นน้ำ **ไม่ได้แปลว่าแห้ง**
  - Google alerts ตอบ 404 **ไม่ได้แปลว่าไม่มีประกาศ**
- โมเดลระดับโลก (GloFAS, Flood Hub, TE-Global) ไม่รู้จักการปล่อยน้ำของเขื่อน ใน backtest 12 สถานีเจ้าพระยา ไม่มีสถานีใดดีขึ้นถึง 10% จึงห้ามใช้ในตรรกะแจ้งเตือน

**ข้ออ้างที่ยังไม่ยืนยัน** (ห้ามสื่อสารว่าเป็นข้อเท็จจริง)
- ชื่อ tool ของ POPNIX
- AccuWeather / OpenWeather / Tomorrow.io ครอบคลุมประกาศของกรมอุตุฯ หรือไม่
- Google Weather alerts ใช้กับจุดในไทยได้จริงหรือไม่
- Google flash-flood ครอบคลุมไทยหรือไม่
- WAM เป็นระบบเดียวกับ clpp-radar หรือไม่
- TMD HPC มีครบ 50 เขตหรือไม่
- เส้นทาง STAC ของ GISTDA ที่ไม่ต้องใช้ key
- RID SWOC open-data service
- header auth ของ data.go.th (`api-key` หรือ Bearer)
- latency ของ GSMaP_NOW
