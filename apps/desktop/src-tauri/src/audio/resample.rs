//! Akan lineer resampler. Cihaz genelde 44.1/48kHz verir; VAD ve whisper 16kHz
//! mono ister. Konusma/VAD icin lineer enterpolasyon yeterli kalitede ve ucuz;
//! tampon sinirlarini prev ornekle dogru tasir (kesintisiz stream).

pub struct LinearResampler {
    ratio: f64,    // giris / cikis orani (16k'ya inerken > 1)
    pos: f64,      // bir sonraki cikis orneginin mutlak giris-ornek konumu
    total_in: u64, // simdiye kadar tuketilen giris ornegi (mutlak koordinat)
    prev: f32,     // bir onceki tamponun son ornegi (sinir enterpolasyonu icin)
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            ratio: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            total_in: 0,
            prev: 0.0,
        }
    }

    /// Giris orneklerini isler, resample edilmis 16k ornekleri `out`'a ekler.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let base = self.total_in as i64; // input[0]'in mutlak indeksi
        let end = base + input.len() as i64;

        let sample_at = |k: i64| -> f32 {
            if k == base - 1 {
                self.prev
            } else if k >= base && k < end {
                input[(k - base) as usize]
            } else {
                // pos monoton arttigi icin bu dala normalde girilmez.
                0.0
            }
        };

        // k ve k+1 mevcut oldugu surece cikis uret (k = floor(pos)).
        while (self.pos + 1.0) < end as f64 {
            let k = self.pos.floor() as i64;
            let frac = (self.pos - k as f64) as f32;
            let s0 = sample_at(k);
            let s1 = sample_at(k + 1);
            out.push(s0 + (s1 - s0) * frac);
            self.pos += self.ratio;
        }

        self.prev = input[input.len() - 1];
        self.total_in = end as u64;
    }
}
