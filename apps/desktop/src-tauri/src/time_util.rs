//! Ortak Unix ve UTC donusumleri.

pub(crate) fn unix_seconds(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn sivil_tarih(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn utc_parcalar(unix: u64) -> (i64, u32, u32, u32, u32, u32) {
    let (y, m, d) = sivil_tarih((unix / 86_400) as i64);
    let sn = (unix % 86_400) as u32;
    (y, m, d, sn / 3_600, (sn % 3_600) / 60, sn % 60)
}

pub(crate) fn utc_iso(unix: u64) -> String {
    let (y, mo, d, h, mi, s) = utc_parcalar(unix);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
