' Start de Nota-server onzichtbaar op de achtergrond (geen zwart venster).
' Uitvoer gaat naar server.log in deze map, handig als iets niet werkt.
'
' Automatisch starten met Windows: druk Win+R, typ  shell:startup  en
' zet daar een snelkoppeling naar dit bestand neer.
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = folder
shell.Run "cmd /c venv\Scripts\python.exe -u app.py >> server.log 2>&1", 0, False
