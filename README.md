# Ürün Karesi

> Örgü videosu + transkript → Claude ile İngilizce (US) tarif, Gemini ile fotoğraflar, satışa hazır PDF ve Etsy ilan metni.

Uygulama tarayıcıda çalışır; video hiçbir sunucuya yüklenmez. Site: https://nalvuran.github.io/urun-karesi/

## Akış
1. **Video dosyasını seç, transkripti yapıştır** (YouTube "Transkripti göster" kopyası, `0:12 metin` satırları, `.srt` veya `.vtt`).
2. **Metin (Claude):** "📋 Claude için komutu kopyala" → claude.ai'de yeni sohbete yapıştır → yanıttaki kod bloğunu kopyala → "📥 Claude'un yanıtını yapıştır" → "Tarifi uygula".
   Başlık, giriş, malzemeler, ölçü tablosu, kısaltmalar, notlar, bölümlü adımlar, her fotoğrafın anı ve türü (**sonuç** / **teknik**), kapak anı ve Etsy ilan metni yerleşir.
3. **Sarı adımları kontrol et:** Claude emin olmadığı yerlere `[CHECK: ...]` notu koyar (PDF'e yazılmaz).
4. **Kareleri al:** Uygulama her fotoğrafın ham karesini videodan alır. Fotoğrafa dokunup sürükleyerek kırpabilirsin.
5. **Fotoğraflar (Gemini) — otomatik:** 3. bölümde Gemini API anahtarını girip **"✨ Eksik olanları Gemini ile düzenle"**ye bas. Her kare kendi komutuyla Gemini'ye gider, sonuç doğru adıma yerleşir (model: Nano Banana 2.1, isteğe bağlı Pro). Tek fotoğraf için adımı açıp **"✨ Gemini ile düzenle"**, kapak için **"✨ Kapağı Gemini ile düzenle"**. Anahtar sadece tarayıcıda saklanır; görsel başına Google API ücreti uygulanır ve projede faturalandırma açık olmalı.
   **Elle yöntem:** 3. bölümde "Tüm kareleri ve komutları indir" → Gemini'de yeni sohbet açıp zip'teki `1-ONCE-BUNU-YAPISTIR.txt` ana komutunu bir kez yapıştır → kareleri tek tek yükleyip yanına RESULT / TECHNIQUE / COVER yaz → sonuçları indirip hepsini "Gemini görsellerini seç" alanına sürükle.
   Dosya adlarını değiştirmeye gerek yok: görseller ham karelere benzerliğe göre eşleştirilir; altta çıkan listeden kontrol edilir.
   - **Sonuç** komutu: dağınıklığı kaldırır, açık renk temiz fon, ürüne dokunmaz.
   - **Teknik** komutu: parmak duruşu, ip yolu ve tığ konumu aynen kalır; sadece fon ve ışık düzelir.
   - **Eller** seçeneği: genç, bakımlı, açık renk ojeli (varsayılan) / genç, ojesiz / olduğu gibi bırak / kaldır.
   - **İşaretler:** Adımı açıp fotoğrafın üzerine ok veya daire çizin, isterseniz kısa bir yazı ekleyin ("insert hook here", "back loop"). PDF'teki görsele işlenir.
   - **Sıra fotoğrafları:** Zor adımlarda 2–3 ardışık kare (Claude zor adımlar için önerir; adımı açıp "+ Videodaki andan sıra fotoğrafı ekle" ile de eklenir). PDF'te numaralı şerit olarak görünür.
   - **İlmek rehberi:** Claude tarifte geçen temel ilmekleri yeni başlayanlar için kısa adımlarla yazar; videodan fotoğrafları alınır, PDF'te "Stitch guide" sayfası olur.
   - **Yakın kadraj:** Teknik fotoğraflar varsayılan olarak işin olduğu bölgeye yakın kırpılır ("Kırpmayı sıfırla" ile tam kare).
6. **PDF:** Alanları gözden geçir, mağaza adını yaz, kapak karesini al (Gemini kapak görselini yükle) → "PDF olarak kaydet". Yazdırma penceresinde **"Üstbilgi ve altbilgi"yi kapat**.
7. **Etsy ilanı** metinlerini kopyala. **💾 Projeyi kaydet** ile metni sakla.

Gemini görseli yüklenmeyen adımlarda PDF'e ham kare (kırpılmış, ışığı düzeltilmiş) girer.

## Diğer yollar
- **API ile otomatik yaz:** Claude API anahtarı girersen tarif metni kopyala-yapıştırsız yazılır (kullanım başına ücretli; [fiyatlar](https://platform.claude.com/docs/en/about-claude/pricing)).
- **Yapay zekâsız: satır satır:** transkriptin her satırı bir adım olur.

## Dosyalar
`index.html`, `style.css`, `app.js` (arayüz), `pattern.js` (Claude komutu ve tarif biçimi), `gemini.js` (Gemini komutları), `transcript.js` (transkript okuma), `processing.js` (zaman ve ışık yardımcıları).

## Notlar
- Sayfa yenilenirse alınan kareler ve yüklenen görseller kaybolur; proje dosyası sadece metni saklar.
- iPhone HEVC (.mov) videolar Chrome'da açılmayabilir; Safari kullan ya da MP4'e çevir.
- Gemini görsellerini ham kareyle karşılaştır: teknik fotoğraflarda ilmek ve el konumu değişmemiş olmalı.

## Lisans
MIT
