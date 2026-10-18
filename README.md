# Ürün Karesi

> Örgü videosu + transkript → İngilizce (US) tarif, adım fotoğrafları, satışa hazır PDF ve Etsy ilan metni.

Örgü videosu ve transkriptinden **adım adım ürün fotoğrafları** çıkarır, **elleri ve arka planı siler**, ürünü **beyaz fonda** gösterir ve hepsini **PDF tarif kitapçığı** olarak kaydeder.

Her şey tarayıcıda çalışır: video hiçbir sunucuya yüklenmez. Bu yüzden GitHub Pages'te ücretsiz yayınlanabilir; telefondan da kullanılır.

## Nasıl kullanılır
1. **Bir kez:** "⚙ Yapay zekâ ayarları"na Claude API anahtarını gir ([Claude Console](https://platform.claude.com/settings/keys) → API Keys). Anahtar sadece tarayıcında saklanır.
2. **Video dosyasını seç**, **transkripti yapıştır** (YouTube "Transkripti göster" kopyası, `0:12 metin` satırları, `.srt` veya `.vtt`).
3. **✨ Tarifi yapay zekâyla yaz**'a bas. Claude transkripti İngilizce, US terimli bir tarife çevirir:
   başlık, giriş, zorluk, malzemeler, araçlar, ölçü tablosu, kısaltmalar, notlar, bölümlere ayrılmış adımlar,
   her fotoğrafın videodaki anı ve Etsy ilan metni (başlık, açıklama, 13 etiket).
4. **Sarı işaretli adımlara bak.** Yapay zekâ emin olmadığı yerlere `[CHECK: ...]` notu koyar. Bu notlar PDF'e yazılmaz ama içerik mutlaka kontrol edilmeli.
5. **Fotoğrafları çıkar**'a bas. ⚠ işaretli fotoğraflara dokunup düzelt: zamanı değiştir, yakın kareleri tara veya "Elle düzelt" ile kalan el parçasını sil.
6. **PDF tarif** bölümündeki alanları gözden geçir, tasarımcı adını yaz, kapak fotoğrafını seç ve **PDF olarak kaydet**'e bas.
7. **Etsy ilanı** bölümündeki metinleri kopyala.
8. **💾 Projeyi kaydet** ile yapay zekânın yazdığı metni saklarsın; sonra açınca tekrar ücret ödemeden devam edersin. (Fotoğraflar dosyaya girmez; aynı videoyu seçip yeniden çıkarırsın.)

Yapay zekâ olmadan da çalışır: **"Yapay zekâsız: satır satır"** transkriptin her satırını bir adım yapar (metni elle düzenlersin).

### Maliyet
Claude API kullanım başına ücretlidir. 20 dakikalık bir video için Sonnet 5.5 ile yaklaşık 0,10 $, Opus 5.5 ile yaklaşık iki katı. Güncel fiyatlar: [Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing).

### Yüzlerce video için öneri
- İlk 3–5 tarifi örgü bilen birine okut; sayılar ve teknik doğru mu, gör. Sonra seri üretime geç.
- Her video için projeyi kaydet; bir şey ters giderse yeniden yazdırmak zorunda kalmazsın.

## Nasıl çalışıyor
| Adım | Kullanılan araç |
|---|---|
| Kareyi almak | Tarayıcının video oynatıcısı + canvas |
| Elleri bulmak | MediaPipe Hand Landmarker (el iskeleti) + MediaPipe çok sınıflı segmentasyon (ten bölgeleri) |
| Arka planı silmek | @imgly/background-removal |
| Elin kapattığı yeri doldurmak | Kenardan içeri doğru renk tamamlama (`processing.js`) |
| Tarif metni ve Etsy ilanı | Claude API (`pattern.js`) |

**Önemli sınır:** Elin kapattığı bölge videoda hiç görünmediği için gerçek görüntü değil, çevresindeki renklere bakılarak yapılan bir tahmindir. Küçük boşluklarda fark edilmez; büyük boşluklarda bulanık görünebilir. Bu durumda "Elin kapattığı yerleri tahminle doldur" seçeneğini kapatıp boşluğu beyaz bırakabilirsin.

## GitHub Pages'te yayınlama
1. GitHub'da yeni bir depo aç (ör. `urun-karesi`).
2. Bu klasördeki tüm dosyaları (`index.html`, `app.js`, `processing.js`, `transcript.js`, `pattern.js`, `style.css`, `.nojekyll`, `README.md`) depoya yükle.
3. Depoda **Settings → Pages** bölümüne gir. **Source**: "Deploy from a branch", **Branch**: `main` / `(root)` seç ve kaydet.
4. Bir iki dakika sonra site `https://KULLANICI_ADIN.github.io/urun-karesi/` adresinde açılır.

> Dosyayı bilgisayarda çift tıklayarak açarsan çalışmaz (tarayıcı güvenlik kuralı). Yerelde denemek için klasörde `python -m http.server` çalıştırıp `http://localhost:8000` adresini aç.

## Bilinen durumlar
- İlk kullanımda modeller indirilir (yaklaşık 50–90 MB). Sonraki kullanımlar hızlıdır.
- iPhone'da çekilmiş HEVC (.mov) videolar Chrome'da açılmayabilir; Safari'de açılır ya da videoyu MP4 olarak kaydet.
- El algılama modeli insan ellerine göre eğitildi; eldivenli eller veya çok bulanık kareler kaçabilir. Elle düzelt sekmesi bunun için var.
- Uygulama sayfası yenilenince çıkarılan fotoğraflar kaybolur; PDF'i kaydetmeden sayfayı kapatma.
- Bej/ten rengi iplikte "Ten rengi algılama" ürünün bir kısmını silebilir; bu durumda bu ayarı düşür veya kapat.

## Lisans
Bu projenin kodu MIT lisanslıdır. Arka plan silme için kullanılan [@imgly/background-removal](https://github.com/imgly/background-removal-js) kütüphanesi AGPL-3.0 lisanslıdır; bu proje açık kaynak olarak yayınlandığı sürece kişisel ve açık kaynak kullanım için uygundur. Ticari/kapalı kaynak kullanım için IMG.LY lisans koşullarına bakın.
