# GUI Haritalandirma Analizi

## Genel karar

Uygulama iki farkli operasyon yuzeyi olarak konumlanmali:

- Arama operasyon paneli: is dagitimi, calisan takibi, sonuc girisi ve geri arama disiplinini yonetir.
- Teklif ofisi: fiyat listesi, teklif PDF karsilastirma, urun eslestirme, karar ve cikti hazirlama surecini yonetir.

Bu ayrim dogru. Sistem arama yapmadigi icin arama panelinde ana vurgu "calisana is yaptirma ve ne yaptigini gorme" olmali. Teklif tarafinda ana vurgu "hata yakalama, karar verme ve kontrollu cikti alma" olmali.

## Arama paneli haritasi

1. Oturum durumu
   - Kullanici, rol, secili liste, canlilik ve yenileme bilgisi.
   - Uygun kullanim: sistemin calisip calismadigini gormek.

2. Gunluk kontrol
   - Atanmamis kayit, bosta operator, geciken takip, gunluk hedef.
   - Uygun kullanim: yoneticinin once hangi aksiyona gidecegini secmesi.

3. Operasyon kontrolu
   - Genel metrikler ve ekip sagligi.
   - Uygun kullanim: gidişati okumak.

4. Kayit filtresi
   - Firma, durum, operator ve takip bazinda daraltma.
   - Uygun kullanim: asil tabloyu islenebilir hale getirmek.

5. Operasyon kayitlari
   - Durum, sonuc, not, takip ve kaydet aksiyonu.
   - Uygun kullanim: operatorun veya yoneticinin satir bazli isi kapatmasi.

6. Yardimci pencereler
   - Ekip, liste, islem havuzu, operator kontrolu.
   - Uygun kullanim: ana ekrani sisirmeden detay yonetmek.

## Teklif ofisi haritasi

1. Kontrol merkezi
   - Fiyat listesi, teklif PDF ve fiyat modu secimi.
   - Uygun kullanim: karsilastirmayi baslatmak.

2. Toplu kontrol
   - Birden fazla PDF'i hata ekranina tasimak.
   - Uygun kullanim: operasyonel teklif kontrolu.

3. Sonuc analizi
   - Kalem panosu, finansal kontrol, akilli oneri.
   - Uygun kullanim: problemi okumak.

4. Karar merkezi
   - Manuel eslestirme, bilesen override, kalem atlama, PDF'e yazilacak satir secimi.
   - Uygun kullanim: cikti oncesi karar vermek.

5. Teklif uretimi
   - Sablon ve katalogdan yeni teklif PDF'i uretmek.

6. Ayarlar
   - Aktif kutuphane, fiyat listesi ve sablon yonetimi.

## Uygunluk degerlendirmesi

Arama paneli islevsel olarak uygun. Yeni gunluk kontrol alani, yoneticinin once atama mi takip mi operator mu bakmasi gerektigini daha net gosteriyor. Tablo yogunlugu hala yuksek ama is modeli geregi kabul edilebilir; asil risk tablodaki aksiyonlarin uzun yatay yuzeyde kaybolmasiydi, sticky islem kolonu bunu azaltiyor.

Teklif ofisi islevsel olarak uygun. En kritik gelisme karar merkezine filtre ve arama gelmesi oldu. Cunku cok kalemli tekliflerde kullanici artik sadece sayfada kaybolmadan "PDF'e yazilacak", "urun bekleyen", "atlanan" veya "onayli" satirlari ayirabiliyor.

## Sonraki GUI firsatlari

1. Arama panelinde satir detay cekmecesi
   - Tablo satirina tiklayinca firma detayini, gecmis notlari ve hizli sonuc aksiyonlarini sag panelde acmak.
   - Fayda: yatay tablo baskisini azaltir.

2. Teklif tarafinda PDF diff onizleme
   - Duzeltme yapilacak satirin eski fiyat/yeni fiyat halini PDF baglaminda gostermek.
   - Fayda: kullanici PDF cikti almadan once neyin degisecegini gorur.

3. Karar merkezinde "otomatik islem paketi"
   - Guvenli fiyat farklarini, atlanan katalog disi kalemleri ve manuel bekleyenleri tek ozet blokta toplamak.
   - Fayda: cikti oncesi hata riskini azaltir.

4. Operator performans haritasi
   - Operator kartlarini sadece metrik olarak degil, "bosta", "takipte", "hedef gerisinde", "tamamlandi" gruplarina bolmek.
   - Fayda: yoneticiye daha hizli gorev dagitimi saglar.

5. Mobil/ufak ekran aksiyon modu
   - Arama tablosunda mobilde full tablo yerine tek kayit karti + sonraki/onceki gecis.
   - Fayda: sahada veya dar ekranda kullanimi rahatlatir.

