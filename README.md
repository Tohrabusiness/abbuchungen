# Abbuchungen

Persönliche Finanz-App (PWA): wann wird was abgebucht, was kommt rein, wie hoch ist der Kontostand.

- **Übersicht, Woche, Monat**: Ausgaben, Einnahmen und Saldo je Zeitraum
- **Posten**: wiederkehrende Ausgaben und Einnahmen (wöchentlich bis jährlich)
- **Konten**: Startwert eintragen, die App rechnet Einnahmen und Abbuchungen automatisch mit und zeigt eine Vorschau
- **Schulden**: "ich schulde" und "mir geschuldet", Teilzahlungen und automatische Raten

Alle Daten liegen nur lokal im Browser (IndexedDB). Sicherung über "Daten" (Export/Import als JSON).

## Update veröffentlichen (Windows PowerShell)

    Expand-Archive -Path "$HOME\Downloads\abbuchungen-update.zip" -DestinationPath "$HOME\abbuchungen" -Force
    cd $HOME\abbuchungen
    git add .
    git commit -m "Einnahmen, Konten, Schulden"
    git push
    gh api repos/Tohrabusiness/abbuchungen/pages --jq ".status"   # warten bis "built"

## Tests

    node tests/logic.test.js
