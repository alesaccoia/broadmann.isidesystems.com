# Atlante di Brodmann

Viewer 3D delle aree di Brodmann sul cervello medio fsaverage, per lo studio dei corsi Neuro-AI. Interfaccia in inglese. Estetica ripresa da isidesystems.com (fondo `#f4f2ed`, Inter 400) con un secondo carattere serif, ET Book, per controlli e testi, e impostazione alla Tufte: numeri delle aree scritti direttamente sulla corteccia, confini sottili, tinte tenui, nessuna legenda.

## Avvio

Il sito è statico e sta in `web/`. Serve un server locale, perché i dati si caricano con `fetch`:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory hcai/atlante-brodmann/web
```

In Claude Code la configurazione `atlante-brodmann` è già in `.claude/launch.json`.

## Cosa fa

- Superficie piale completa dei due emisferi (163.842 vertici ciascuno), con ombreggiatura dei solchi.
- Aree di Brodmann con confini e numeri sulla superficie; passaggio del mouse con area, giro ed emisfero; clic per isolare un'area e aprire la scheda (sede, funzione, giri in cui ricade, tavola originale del 1909). Un numero compare solo dove la sua area è davvero visibile in quel punto.
- Finestre «Help» e «About» (autore, fonti, limiti).
- Mappa alternativa per giri (atlante Desikan-Killiany), con sede e funzione di ogni giro e le aree di Brodmann che vi ricadono calcolate dai dati.
- «Gonfia»: transizione continua fra superficie piale e superficie gonfiata, per vedere ciò che sta nei solchi.
- Sezioni sagittale, coronale e assiale: la superficie viene tagliata e sul piano compare la risonanza T1 con le aree nel nastro corticale.

## Struttura

- `pipeline/build.py`: converte fsaverage in binari per il web (`web/data/`). Si rilancia con `pipeline/.venv/bin/python pipeline/build.py`.
- `raw/fsaverage/`: dati FreeSurfer scaricati con `mne.datasets.fetch_fsaverage` (circa 760 MB, rigenerabili; al viewer non servono).
- `web/app.js`: scena Three.js, shader, picking su GPU, interfaccia. `web/aree.js`: testi delle schede (aree e giri). `web/fonts/`: Inter e ET Book (licenza MIT). `web/tavole/`: tavole di Brodmann da Wikimedia Commons (pubblico dominio).

## Fonti e limiti

- Confini delle aree: annotazione `PALS_B12_Brodmann` (Van Essen, 2005) distribuita con fsaverage. È una proiezione media: le aree di Brodmann sono definite dalla citoarchitettura e variano da cervello a cervello.
- Sulla superficie mancano le aree 12, 34 e 52; l'insula non è suddivisa (viene da Desikan-Killiany); alcuni tratti attorno alla scissura laterale restano senza area.
- Le aree nelle sezioni sono le etichette di superficie proiettate fra sostanza bianca e superficie piale: valgono solo per la corteccia. Le strutture sottocorticali si vedono nella risonanza ma non sono etichettate.
- I testi delle schede sono sintesi di studio scritte con l'assistente, non tratte dal materiale dei corsi: vanno verificati sui testi d'esame.
