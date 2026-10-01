# Waga plików (file-size-tool)

Strona, która w przeglądarce:

- **generuje plik o zadanej wadze** z dowolnym rozszerzeniem (co do bajta),
- **zmienia wagę istniejącego pliku**, np. z 95 MB na 90 MB albo z 2 MB na 5 MB.

Pliki nie są nigdzie wysyłane. Wszystko liczy się lokalnie w przeglądarce.

Na żywo: https://mrcanon19.github.io/file-size-tool/

## Generowanie

Rozszerzenie wybierasz z listy codziennych formatów (dokumenty, arkusze, prezentacje, zdjęcia, archiwa) albo wpisujesz własne przez „Inne”. Wagę można wpisać z przecinkiem albo kropką, np. `95,5`.

Dla tych rozszerzeń powstaje **poprawny plik, który się otwiera** (mała zawartość testowa + wypełnienie):

`pdf`, `docx`, `odt`, `rtf`, `txt`, `xlsx`, `csv`, `ods`, `pptx`, `heic`, `jpg`, `png`, `webp`, `gif`, `bmp`, `svg`, `zip`, a przez „Inne” także `mp4`, `m4v`, `mov`, `mp3`, `wav` i pliki tekstowe (`json`, `md`, …).

Każde inne rozszerzenie (np. `doc`, `xls`, `ppt`, `pages`, `numbers`, `key`, `tiff`, `rar`, `7z`) dostaje właściwą nazwę i wagę, ale w środku jest tylko wypełnienie (zera, losowe bajty albo tekst). Do testowania limitów uploadu to zwykle wystarcza.

## Powiększanie

Wypełnienie trafia tam, gdzie format je toleruje:

| Format | Gdzie trafia wypełnienie |
|---|---|
| xlsx, docx, pptx, odt, ods, epub | białe znaki po głównym elemencie XML wewnątrz archiwum (np. `docProps/app.xml`) |
| zip, jar | dodatkowy plik `padding.bin` w archiwum |
| mp4, mov, m4a, heic, heif, avif | blok `free` na końcu (odtwarzacze go pomijają) |
| mp3 | znacznik ID3v2 na początku (czas trwania się nie zmienia) |
| pdf | komentarz PDF + powtórzony `startxref` |
| pozostałe | bajty dopisane na końcu |

## Zmniejszanie

| Format | Jak |
|---|---|
| jpg, webp | niższa jakość, a gdy to za mało, niższa rozdzielczość |
| png | niższa rozdzielczość |
| heic | dekodowanie przez heic2any, wynik w **JPG** (przeglądarki nie zapisują HEIC) |
| pdf | Ghostscript (pdfwrite) w przeglądarce: najpierw samo uporządkowanie struktury, potem coraz mocniejsza kompresja zdjęć (300 → 50 dpi). Wybierany jest najłagodniejszy poziom, który się mieści. Tekst i wektory zostają |
| xlsx, docx, pptx, odt, ods, epub | mocniejsza kompresja ZIP, potem zmniejszenie zdjęć w środku; dane i tekst bez zmian |
| zip | mocniejsza kompresja, zawartość bez zmian |
| wideo | przekodowanie do MP4 (H.264 + AAC) z bitrate dobranym do wagi, ffmpeg.wasm |
| audio | przekodowanie do MP3 (m4a/aac zostają w M4A), ffmpeg.wasm |

Domyślnie wynik jest dopełniany do dokładnej wagi docelowej (można to wyłączyć).

Ograniczenia:

- Wideo kodowane jest w przeglądarce (4 wątki, gdy przeglądarka na to pozwala), czyli wolniej niż w programie na komputerze. Test: 20 s wideo 720p, 22,7 → 10 MB, ok. 100 s na MacBooku. Plik rzędu 100 MB może się liczyć kilkanaście minut lub dłużej. Limit to ok. 1,5 GB.
- Pliki ZIP i Office powyżej 4 GB nie są obsługiwane (brak ZIP64).
- PDF: pierwsze zmniejszenie pobiera Ghostscript (ok. 15 MB). Test: 8 stron ze zdjęciami, 15,7 → 3 MB w ok. 30 s. PDF zabezpieczony hasłem nie zadziała.
- Plików zabezpieczonych hasłem ani formatów nieznanych nie da się zmniejszyć bez uszkodzenia.
- Stare formaty Office (`xls`, `doc`, `ppt`) po powiększeniu mogą zgłosić błąd.

## Jednostki

Przełącznik u góry: `1 MB = 1000 KB` (macOS, większość stron www) albo `1 MB = 1024 KB` (Windows).

## Uruchomienie lokalnie

```bash
python3 -m http.server 8765
# http://127.0.0.1:8765/
```

Bez budowania i bez zależności do instalowania. Biblioteki:

- [`@ffmpeg/ffmpeg` 0.12.15 i `@ffmpeg/util` 0.12.2](https://github.com/ffmpegwasm/ffmpeg.wasm) (MIT) są w `vendor/`, żeby worker ładował się z tej samej domeny; rdzeń `@ffmpeg/core` 0.12.10 pobierany z jsDelivr dopiero przy zmniejszaniu wideo i audio,
- [`fflate`](https://github.com/101arrowz/fflate) 0.8.3 (MIT) i [`heic2any`](https://github.com/alexcorvi/heic2any) 0.0.4 (MIT) z jsDelivr, ładowane na żądanie.

[`@okathira/ghostpdl-wasm`](https://github.com/okathira/ghostpdl-wasm) 1.1.0, czyli Ghostscript w WebAssembly, pobierany z jsDelivr dopiero przy zmniejszaniu PDF. Licencja **AGPL-3.0**: kod źródłowy tej strony jest publiczny, a źródła Ghostscript są w repo okathira/ghostpdl-wasm.

[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) 0.1.7 (MIT) dodaje nagłówki COOP/COEP, których GitHub Pages nie ustawia. Dzięki temu działa wielowątkowy `@ffmpeg/core-mt`. Przy pierwszej wizycie strona przeładowuje się raz.

`templates.js` zawiera małe poprawne pliki (heic, mp4, mov, mp3, gif) wygenerowane przez ffmpeg i `sips`.
