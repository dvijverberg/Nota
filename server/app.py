import json
import os
import sys

# De cuBLAS/cuDNN pip-packages zetten hun DLL's in site-packages i.p.v. de
# systeem-PATH. Windows zoekt DLL's daar niet automatisch, dus wijzen we
# Python er expliciet naartoe vóór faster_whisper geimporteerd wordt.
_venv_site_packages = os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages")
for _pkg in ("cublas", "cudnn"):
    _dll_dir = os.path.join(_venv_site_packages, "nvidia", _pkg, "bin")
    if os.path.isdir(_dll_dir):
        os.add_dll_directory(_dll_dir)

import csv
import hashlib
import io
import re
import threading
import urllib.request
from datetime import date, datetime
from urllib.parse import urlencode

from flask import Flask, Response, redirect, request, jsonify, render_template, send_from_directory
from faster_whisper import WhisperModel
from supabase import create_client

import db
from app_secrets import SUPABASE_URL, SUPABASE_SERVICE_KEY

app = Flask(__name__)

# Server-side Supabase-client (service_role -- omzeilt RLS, dus alleen hier
# gebruiken, nooit deze key naar een client sturen). Pusht na elke transcriptie
# een kopie naar de cloud zodat notities ook zonder deze pc bekeken kunnen
# worden. Faalt de cloud-push (bv. geen internet), dan gaat de rest gewoon
# door -- de lokale kopie is en blijft de bron van waarheid.
supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def cloud_audio_path(note_id, filename):
    # note_id (primary key) als prefix: filenames zijn NIET gegarandeerd uniek
    # (bv. na hernummering kunnen twee notities toevallig dezelfde bestandsnaam
    # hebben -- ontdekt tijdens de backfill), dus zonder dit zouden twee
    # notities elkaars audio in de cloud-storage kunnen overschrijven.
    return f"{note_id}_{filename}"


def push_note_to_cloud(note_id, filename, label, duration_sec, timestamp, transcription, title, summary, action_items_json, file_bytes, content_type="audio/wav"):
    try:
        cloud_path = cloud_audio_path(note_id, filename)
        supabase.storage.from_("audio").upload(
            cloud_path,
            file_bytes,
            {"content-type": content_type, "upsert": "true"},
        )
        supabase.table("notes").upsert({
            "id": note_id,
            "label": label,
            "duration_sec": duration_sec,
            "note_timestamp": timestamp,
            "transcription": transcription,
            "title": title,
            "summary": summary,
            "action_items": action_items_json,
            "audio_path": cloud_path,
        }).execute()
        print(f"Notitie {note_id} gesynced naar Supabase.")
    except Exception as exc:
        print(f"Kon notitie {note_id} niet naar Supabase pushen (lokaal blijft wel werken): {exc}")


def push_action_items_to_cloud(note_id, action_items_json):
    # Losse, lichte update i.p.v. de volledige push_note_to_cloud() -- een
    # vinkje togglen moet niet opnieuw het audiobestand uploaden.
    try:
        supabase.table("notes").update({"action_items": action_items_json}).eq("id", note_id).execute()
    except Exception as exc:
        print(f"Kon actiepunt-status van notitie {note_id} niet naar Supabase pushen: {exc}")


def delete_note_from_cloud(note_id, filename):
    try:
        supabase.table("notes").delete().eq("id", note_id).execute()
        supabase.storage.from_("audio").remove([cloud_audio_path(note_id, filename)])
    except Exception as exc:
        print(f"Kon notitie {note_id} niet uit Supabase verwijderen: {exc}")

# Eén plek om de naam van de webinterface aan te passen.
SITE_NAME = "Nota"

# Eigen kleur per label-categorie (badge in de webinterface). "Overig" heeft
# bewust geen eigen entry -- valt net als een écht ontbrekend label terug op
# DEFAULT_LABEL_COLOR, wat qua betekenis toch al bij elkaar past.
LABEL_COLORS = {
    "persoonlijk": "#9333ea",  # paars
    "werk": "#ea580c",        # oranje
    "sport": "#16a34a",       # groen
    "reizen": "#0d9488",      # teal
}
DEFAULT_LABEL_COLOR = "#7a726c"  # warmgrijs, past bij de nieuwe tekstkleur

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

db.init_db()

print("Whisper-model laden (large-v3, eenmalig bij opstarten)...")
model = WhisperModel("large-v3", device="cuda", compute_type="float16")
print("Model geladen.")

# Het model wordt nu door twee dingen gebruikt: uploads van het e-ink-board
# (Flask-request) en de wachtrij met telefoonopnames (achtergrondthread).
# Eén GPU-model tegelijk aanroepen vanuit twee threads is vragen om
# problemen, dus om de beurt via dit slot.
TRANSCRIBE_LOCK = threading.Lock()


def transcribe_file(path):
    """Transcribeert één audiobestand (wav van het board, webm/m4a van de
    telefoon -- PyAV leest die allemaal). Geeft (tekst, info) terug."""
    with TRANSCRIBE_LOCK:
        segments, info = model.transcribe(path, language="nl")
        # segments is een generator: binnen het slot helemaal uitlezen,
        # anders gebeurt het echte werk pas ná het vrijgeven.
        text = " ".join(segment.text.strip() for segment in segments)
    return text, info

# AI-samenvatting: lokaal via Ollama (gratis, privé, draait op dezelfde GPU
# als Whisper) i.p.v. een betaalde API -- was een harde eis.
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
OLLAMA_MODEL = "qwen2.5:7b"

SUMMARY_PROMPT_TEMPLATE = """Je krijgt de transcriptie van een gesproken spraaknotitie (Nederlands). Vandaag is het {today_long} ({today}). Genereer:
1. Een korte titel (max 6 woorden, geen aanhalingstekens)
2. Een korte samenvatting (1-2 zinnen)
3. Een lijst met concrete actiepunten die de spreker noemt (lege lijst als er geen zijn).
   Schrijf elk actiepunt als korte taak die begint met een werkwoord of onderwerp, zonder de datum erin.
   Noemt de spreker wanneer het moet ("morgen", "vrijdag", "volgende week", "om 9 uur"), zet dan de datum
   in "due" als JJJJ-MM-DD en een eventuele tijd in "time" als UU:MM. Anders null.

Transcriptie:
\"\"\"
{transcript}
\"\"\"

Antwoord ALLEEN met geldige JSON, exact in dit formaat, geen andere tekst:
{{"title": "...", "summary": "...", "action_items": [{{"text": "...", "due": null, "time": null}}]}}
"""

DUTCH_WEEKDAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
DUTCH_MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
                "augustus", "september", "oktober", "november", "december"]


def clean_action_item(item):
    """Eén actiepunt van het model -> {text, done[, due, time]}. Het model mag
    een kale string of een object teruggeven; datum/tijd alleen bewaren als
    ze er echt geldig uitzien (een 7b-model verzint soms rare formaten)."""
    if isinstance(item, str):
        return {"text": item.strip(), "done": False} if item.strip() else None
    if not isinstance(item, dict):
        return None
    text = str(item.get("text") or "").strip()
    if not text:
        return None
    result = {"text": text, "done": False}
    due = str(item.get("due") or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", due):
        try:
            if date.fromisoformat(due) >= date.today():
                result["due"] = due
                time_value = str(item.get("time") or "").strip()
                if re.fullmatch(r"\d{1,2}:\d{2}", time_value):
                    result["time"] = time_value
        except ValueError:
            pass
    return result


def generate_summary(transcription):
    """Titel + samenvatting + actiepunten via Ollama. Faalt dit (Ollama niet
    gestart, model ontbreekt, ongeldige JSON terug), dan gaat de rest van de
    upload gewoon door zonder samenvatting -- nooit de hele flow breken op
    iets wat puur "extra" is."""
    if not transcription or not transcription.strip():
        return None, None, []

    today = date.today()
    today_long = f"{DUTCH_WEEKDAYS[today.weekday()]} {today.day} {DUTCH_MONTHS[today.month - 1]} {today.year}"
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": SUMMARY_PROMPT_TEMPLATE.format(
            transcript=transcription, today=today.isoformat(), today_long=today_long),
        "stream": False,
        "format": "json",
    }
    try:
        req = urllib.request.Request(
            OLLAMA_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
        parsed = json.loads(result["response"])
        title = parsed.get("title") or None
        summary = parsed.get("summary") or None
        raw_action_items = parsed.get("action_items") or []
        if not isinstance(raw_action_items, list):
            raw_action_items = []
        # Elk actiepunt is een {text, done}-object (niet een kale string) zodat
        # de vinkjes een aan/uit-status hebben om in op te slaan. Optioneel
        # met "due"/"time": de Nota-app maakt daar een taak mét datum van.
        action_items = [cleaned for cleaned in (clean_action_item(i) for i in raw_action_items) if cleaned]
        return title, summary, action_items
    except Exception as exc:
        print(f"AI-samenvatting mislukt (gaat door zonder): {exc}")
        return None, None, []


def normalize_action_items(raw_json):
    """Parseert de action_items-kolom en zet elk item om naar een
    {text, done}-object. Vangt ook nog niet-gemigreerde oude notities op
    (kale string i.p.v. object), zodat een gemiste backfill niet crasht."""
    try:
        items = json.loads(raw_json) if raw_json else []
    except (TypeError, json.JSONDecodeError):
        return []
    normalized = []
    for item in items:
        if isinstance(item, str):
            normalized.append({"text": item, "done": False})
        elif isinstance(item, dict):
            # Extra velden (due/time) gaan hier verloren, maar dit wordt alleen
            # voor weergave en het togglen op de pc gebruikt; de taak in de app
            # heeft zijn datum al bij het aanmaken gekregen.
            normalized.append({"text": item.get("text", ""), "done": bool(item.get("done"))})
    return normalized


# Vaste volgorde voor het to-do-overzicht bovenaan de pagina. Bewust geen
# "overig"-vangnet-categorie meer (5 kolommen gaf een lelijke 4+1-layout) --
# notities met een niet-herkend label worden simpelweg overgeslagen in dit
# overzicht (de actiepunten blijven wel gewoon zichtbaar/afvinkbaar op de
# notitie zelf, dit overzicht is alleen een snel "wat moet ik nog doen").
TODO_CATEGORIES = ["persoonlijk", "werk", "sport", "reizen"]
TODO_CATEGORY_NAMES = {
    "persoonlijk": "Persoonlijk",
    "werk": "Werk",
    "sport": "Sport",
    "reizen": "Reizen",
}


def get_open_todos_by_category():
    """Groepeert alle nog-openstaande actiepunten van alle notities per
    label-categorie, voor het to-do-overzicht bovenaan de pagina. Alleen
    open items -- afgevinkte/volledige lijsten blijven gewoon zichtbaar per
    notitie verderop, dit overzicht is puur "wat moet ik nog doen"."""
    columns = {cat: [] for cat in TODO_CATEGORIES}
    for row in db.get_all_notes():
        if row["label"] not in TODO_CATEGORIES:
            continue
        for index, item in enumerate(normalize_action_items(row["action_items"])):
            if not item["done"]:
                columns[row["label"]].append({
                    "note_id": row["id"],
                    "item_index": index,
                    "text": item["text"],
                })
    return [
        {
            "key": cat,
            "name": TODO_CATEGORY_NAMES[cat],
            "color": LABEL_COLORS.get(cat, DEFAULT_LABEL_COLOR),
            # "todos" i.p.v. "items" -- die laatste naam botst in Jinja met
            # dict.items() (elke Python-dict heeft die methode al), waardoor
            # col.items de ingebouwde methode teruggeeft i.p.v. deze lijst.
            "todos": columns[cat],
        }
        for cat in TODO_CATEGORIES
    ]


def format_display_time(value):
    """Zet een 'timestamp' (ISO, van de ESP32) of 'created_at' (SQLite,
    upload-tijd) om naar een leesbare NL-notatie. Geeft None terug als de
    waarde ontbreekt of niet te parsen is."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return value
    return dt.strftime("%d-%m-%Y %H:%M")


def format_total_duration(total_seconds):
    """Leesbare totaaltijd voor de header-stat. None als er niks is om te
    tonen (voorkomt een raar '0 min'-regeltje bij een lege lijst)."""
    if not total_seconds:
        return None
    if total_seconds < 60:
        return "<1 min"
    return f"{round(total_seconds / 60)} min"


def current_filters():
    """Leest q/label/sort uit de querystring. Op meerdere plekken nodig
    (pagina zelf, export-link, terug-redirect na verwijderen) zodat een
    actieve zoekopdracht/filter niet verloren gaat."""
    return {
        "q": request.args.get("q", "").strip(),
        "label": request.args.get("label", "").strip(),
        "sort": request.args.get("sort", "newest").strip(),
    }


def reconcile_with_cloud():
    """De mobile-viewer schrijft rechtstreeks naar Supabase (geen pc-server
    ertussen), dus vinkjes en verwijderingen die vanaf de telefoon gebeuren
    komen hier nooit vanzelf binnen. Bij elke keer dat de pc-webinterface
    laadt, spiegelen we de cloud-stand terug: notities die niet meer in de
    cloud staan worden ook lokaal verwijderd, en een afwijkende
    action_items-status wordt lokaal overgenomen (cloud is voor dit veld
    altijd minstens zo vers, want élke toggle -- ook vanaf de pc zelf --
    pusht al meteen naar Supabase).

    Bij een mislukte Supabase-call gebeurt er bewust NIETS (None i.p.v. een
    lege set) -- anders zou een tijdelijke storing eruitzien als "alles op
    de telefoon verwijderd" en zou dit per ongeluk de hele lokale kopie
    leegvegen."""
    try:
        cloud_rows = supabase.table("notes").select("id, action_items").execute().data
    except Exception as exc:
        print(f"Kon niet met Supabase syncen (blijft bij lokale stand): {exc}")
        return
    cloud_by_id = {row["id"]: row["action_items"] for row in cloud_rows}

    for row in db.get_all_notes():
        note_id = row["id"]
        if note_id not in cloud_by_id:
            wav_path = os.path.join(UPLOAD_DIR, row["filename"])
            if os.path.exists(wav_path):
                os.remove(wav_path)
            db.delete_note(note_id)
        elif cloud_by_id[note_id] != row["action_items"]:
            db.update_action_items(note_id, cloud_by_id[note_id])


@app.route("/")
def index():
    filters = current_filters()
    reconcile_with_cloud()

    rows = db.get_all_notes(
        search=filters["q"] or None,
        label=filters["label"] or None,
        sort=filters["sort"],
    )
    notes = []
    for row in rows:
        note = dict(row)
        # Voorkeur voor het echte opname-tijdstip (timestamp), val terug op
        # de upload-tijd (created_at) voor oudere opnames zonder NTP-sync.
        note["display_time"] = format_display_time(note["timestamp"]) or format_display_time(note["created_at"])
        note["label_color"] = LABEL_COLORS.get(note["label"], DEFAULT_LABEL_COLOR)
        note["action_items"] = normalize_action_items(note["action_items"])
        notes.append(note)

    all_labels = db.get_distinct_labels()
    total_duration = format_total_duration(sum(n["duration_sec"] or 0 for n in notes))

    return render_template(
        "index.html",
        notes=notes,
        site_name=SITE_NAME,
        all_labels=all_labels,
        search=filters["q"],
        selected_label=filters["label"],
        sort=filters["sort"],
        filter_qs=urlencode({k: v for k, v in filters.items() if v}),
        total_duration=total_duration,
        todo_columns=get_open_todos_by_category(),
    )


@app.route("/notes/<int:note_id>/delete", methods=["POST"])
def delete_note(note_id):
    note = db.get_note(note_id)
    if note is not None:
        wav_path = os.path.join(UPLOAD_DIR, note["filename"])
        if os.path.exists(wav_path):
            os.remove(wav_path)
        db.delete_note(note_id)
        delete_note_from_cloud(note_id, note["filename"])

    filters = current_filters()
    qs = urlencode({k: v for k, v in filters.items() if v})
    return redirect(f"/?{qs}" if qs else "/")


@app.route("/notes/<int:note_id>/action-items/<int:item_index>/toggle", methods=["POST"])
def toggle_action_item(note_id, item_index):
    note = db.get_note(note_id)
    if note is None:
        return jsonify({"error": "notitie niet gevonden"}), 404

    action_items = normalize_action_items(note["action_items"])
    if item_index < 0 or item_index >= len(action_items):
        return jsonify({"error": "actiepunt niet gevonden"}), 404

    action_items[item_index]["done"] = not action_items[item_index]["done"]
    action_items_json = json.dumps(action_items)
    db.update_action_items(note_id, action_items_json)
    push_action_items_to_cloud(note_id, action_items_json)

    return jsonify({"done": action_items[item_index]["done"]})


def note_txt_block(row):
    display_time = format_display_time(row["timestamp"]) or format_display_time(row["created_at"]) or "onbekende tijd"
    header = f"[{row['label'] or 'geen label'}] {display_time} ({row['duration_sec'] or '?'}s)"
    return header, row["transcription"] or ""


@app.route("/export")
def export_notes():
    filters = current_filters()
    fmt = request.args.get("format", "txt")
    rows = db.get_all_notes(
        search=filters["q"] or None,
        label=filters["label"] or None,
        sort=filters["sort"],
    )

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["label", "tijdstip", "duur_sec", "transcriptie"])
        for row in rows:
            display_time = format_display_time(row["timestamp"]) or format_display_time(row["created_at"]) or ""
            writer.writerow([row["label"] or "", display_time, row["duration_sec"] or "", row["transcription"] or ""])
        # BOM zodat Excel de UTF-8-tekens (é, ë, ...) goed herkent.
        body = "﻿" + buf.getvalue()
        mimetype = "text/csv"
        filename = "nota-export.csv"
    else:
        lines = []
        for row in rows:
            header, text = note_txt_block(row)
            lines.append(header)
            lines.append(text)
            lines.append("")
        body = "\n".join(lines)
        mimetype = "text/plain"
        filename = "nota-export.txt"

    return Response(
        body,
        mimetype=mimetype,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.route("/notes/<int:note_id>/export")
def export_single_note(note_id):
    note = db.get_note(note_id)
    if note is None:
        return "Notitie niet gevonden", 404

    header, text = note_txt_block(note)
    body = f"{header}\n{text}\n"

    return Response(
        body,
        mimetype="text/plain",
        headers={"Content-Disposition": f"attachment; filename=nota-{note_id}.txt"},
    )


@app.route("/manifest.json")
def manifest():
    data = {
        "name": SITE_NAME,
        "short_name": SITE_NAME,
        "description": "Spraaknotities, automatisch getranscribeerd en doorzoekbaar.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#fafafa",
        "theme_color": "#2563eb",
        "orientation": "portrait-primary",
        "icons": [
            {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/static/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return Response(json.dumps(data), mimetype="application/manifest+json")


@app.route("/audio/<path:filename>")
def serve_audio(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/upload", methods=["POST"])
def upload():
    if "audio" not in request.files:
        return jsonify({"error": "geen 'audio'-bestand in de request"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    # Bestandsnamen zijn NIET gegarandeerd uniek over de levensduur van het
    # board heen: de opnamenummering (rec_NNN) begint gewoon opnieuw te
    # tellen zodra /audio op de SD-kaart leeg is (bijv. na een succesvolle
    # volledige sync), dus een latere, totaal andere opname kan toevallig
    # dezelfde naam krijgen als een oudere, allang gesyncte notitie.
    #
    # Een botsende naam kan dus twee heel verschillende dingen betekenen, en
    # die moeten niet hetzelfde afgehandeld worden:
    #  1. Dezelfde inhoud (byte-voor-byte gelijk): dit IS een dubbele upload
    #     -- bijv. auto-sync meldde "mislukt" (het antwoord van de server
    #     ging verloren) terwijl de upload eigenlijk al gelukt was, en een
    #     latere handmatige Sync stuurt 'm dan nog een keer. Niet opnieuw
    #     transcriberen/opslaan/cloud-pushen, gewoon de bestaande notitie
    #     teruggeven (met 200, anders blijft het board 'm aanbieden).
    #  2. Verschillende inhoud: een toevallige naam-botsing tussen twee
    #     losstaande opnames (is ook echt gebeurd, zie notitie-id 22, wiens
    #     audio zo overschreven werd voor deze check bestond). Het nieuwe
    #     bestand krijgt een tijdstip-achtervoegsel i.p.v. het oude te
    #     overschrijven. De cloud-kant kent dit probleem sowieso al niet
    #     (gebruikt een note-id-prefix, zie cloud_audio_path()).
    filename = audio_file.filename
    save_path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(save_path):
        with open(save_path, "rb") as f:
            existing_bytes = f.read()

        if hashlib.sha256(existing_bytes).digest() == hashlib.sha256(audio_bytes).digest():
            existing = db.get_note_by_filename(filename)
            if existing is not None:
                print(f"Dubbele upload genegeerd (identieke inhoud): {filename} is al notitie {existing['id']}")
                return jsonify({
                    "id": existing["id"],
                    "filename": existing["filename"],
                    "transcription": existing["transcription"],
                    "duplicate": True,
                })
            # Zelfde bytes maar geen bijbehorende db-rij: de vórige poging is
            # kennelijk gecrasht vóórdat de notitie werd aangemaakt (bijv.
            # een corrupt audiobestand waar transcriberen op stukloopt, zie
            # de try/except hieronder). Dit is een retry van dezelfde
            # opname, geen toevallige botsing -- gewoon nog een keer onder
            # dezelfde naam proberen i.p.v. een nieuw bestand aan te maken,
            # anders stapelen mislukte pogingen zich eindeloos op als losse
            # rommelbestanden (is ook echt gebeurd, 9 kopieën van hetzelfde
            # kapotte bestand).
        else:
            stem, ext = os.path.splitext(filename)
            filename = f"{stem}_{datetime.now().strftime('%Y%m%dT%H%M%S')}{ext}"
            save_path = os.path.join(UPLOAD_DIR, filename)
            print(f"Bestandsnaam-botsing (andere inhoud): {audio_file.filename} bestaat al lokaal, opgeslagen als {filename}")

    with open(save_path, "wb") as f:
        f.write(audio_bytes)

    # Optioneel meegestuurde metadata (zelfde vorm als de JSON die de ESP32
    # naast elke WAV schrijft). Zonder metadata-veld (bijv. handmatige test)
    # vallen we terug op lege/onbekende waarden i.p.v. te falen.
    label = None
    duration_sec = None
    timestamp = None
    if "metadata" in request.form:
        try:
            meta = json.loads(request.form["metadata"])
            label = meta.get("label")
            duration_sec = meta.get("duration_sec")
            timestamp = meta.get("timestamp")
        except json.JSONDecodeError:
            pass

    # Een corrupt/onvolledig WAV-bestand (bijv. door een reset midden in een
    # opname) laat faster-whisper/PyAV crashen met een InvalidDataError --
    # dat mag de hele request niet met een onbehandelde 500 laten stuklopen.
    # Netjes falen betekent ook: geen db-rij, dus de volgende retry-poging
    # hierboven wéét dat er nog niks succesvol is opgeslagen.
    try:
        text, info = transcribe_file(save_path)
    except Exception as exc:
        print(f"Transcriptie mislukt voor {filename}: {exc}")
        return jsonify({"error": f"kon audio niet transcriberen: {exc}"}), 400

    title, summary, action_items = generate_summary(text)
    action_items_json = json.dumps(action_items)

    note_id = db.insert_note(
        filename=filename,
        label=label,
        duration_sec=duration_sec,
        timestamp=timestamp,
        transcription=text,
        title=title,
        summary=summary,
        action_items_json=action_items_json,
    )

    with open(save_path, "rb") as f:
        push_note_to_cloud(
            note_id, filename, label, duration_sec, timestamp, text,
            title, summary, action_items_json, f.read(),
        )

    return jsonify({
        "id": note_id,
        "filename": filename,
        "language": info.language,
        "transcription": text,
    })


# ---------------------------------------------------------------------------
# Opnames vanaf de telefoon (Nota-app). De app uploadt de audio naar
# Supabase (audio/phone/...) en zet een rij in de tabel "recordings" met
# status "wachtend". Deze pc pakt die op zodra de server draait, en maakt er
# precies zo'n notitie van als bij een upload van het e-ink-board.
# ---------------------------------------------------------------------------
PHONE_POLL_SECONDS = 10
# Hoe vaak de pc laat weten dat hij aanstaat (de app toont dat bij Notities).
HEARTBEAT_SECONDS = 30
SERVER_VERSION = "2026-11-12"


def send_heartbeat(queue_size):
    try:
        supabase.table("server_status").upsert({
            "id": "pc",
            "last_seen": datetime.now().astimezone().isoformat(),
            "info": {"version": SERVER_VERSION, "queue": queue_size, "model": "large-v3"},
        }).execute()
    except Exception as exc:
        print(f"Kon status niet doorgeven aan Supabase: {exc}")


def process_phone_recording(rec):
    rec_id = rec["id"]
    # "Claimen": alleen doorgaan als de status nog echt "wachtend" was, zodat
    # een tweede server (of een dubbele poll) dezelfde opname niet ook pakt.
    claimed = supabase.table("recordings").update({"status": "bezig", "error": None}) \
        .eq("id", rec_id).eq("status", "wachtend").execute().data
    if not claimed:
        return

    try:
        audio_bytes = supabase.storage.from_("audio").download(rec["audio_path"])

        ext = os.path.splitext(rec["audio_path"])[1] or ".webm"
        try:
            recorded = datetime.fromisoformat(rec["recorded_at"].replace("Z", "+00:00")).astimezone()
        except (AttributeError, ValueError):
            recorded = datetime.now().astimezone()
        filename = f"phone_{recorded.strftime('%Y%m%d_%H%M%S')}_{rec_id[:6]}{ext}"
        save_path = os.path.join(UPLOAD_DIR, filename)
        with open(save_path, "wb") as f:
            f.write(audio_bytes)

        text, info = transcribe_file(save_path)
        if not text.strip():
            raise ValueError("geen spraak gehoord in de opname")
        title, summary, action_items = generate_summary(text)
        action_items_json = json.dumps(action_items)

        duration_sec = rec.get("duration_sec") or round(getattr(info, "duration", 0) or 0) or None
        timestamp = recorded.isoformat(timespec="seconds")
        label = (rec.get("label") or "").strip().lower() or None

        note_id = db.insert_note(
            filename=filename,
            label=label,
            duration_sec=duration_sec,
            timestamp=timestamp,
            transcription=text,
            title=title,
            summary=summary,
            action_items_json=action_items_json,
        )
        push_note_to_cloud(
            note_id, filename, label, duration_sec, timestamp, text,
            title, summary, action_items_json, audio_bytes,
            content_type=rec.get("mime_type") or "audio/webm",
        )

        supabase.table("recordings").update({"status": "klaar", "note_id": note_id}).eq("id", rec_id).execute()
        # Het origineel is nu dubbel (staat ook onder <note_id>_<naam>).
        try:
            supabase.storage.from_("audio").remove([rec["audio_path"]])
        except Exception:
            pass
        print(f"Telefoonopname {rec_id} verwerkt als notitie {note_id}.")
    except Exception as exc:
        print(f"Telefoonopname {rec_id} mislukt: {exc}")
        try:
            supabase.table("recordings").update({"status": "mislukt", "error": str(exc)[:500]}).eq("id", rec_id).execute()
        except Exception:
            pass


def phone_queue_loop():
    import time
    # Na een crash/herstart kan een opname op "bezig" zijn blijven hangen.
    try:
        supabase.table("recordings").update({"status": "wachtend"}).eq("status", "bezig").execute()
    except Exception as exc:
        print(f"Kon wachtrij niet opschonen: {exc}")

    last_heartbeat = 0.0
    while True:
        waiting = []
        try:
            waiting = supabase.table("recordings").select("*") \
                .eq("status", "wachtend").order("created_at").limit(5).execute().data
        except Exception as exc:
            # Geen internet of Supabase even weg: gewoon later opnieuw.
            print(f"Wachtrij telefoonopnames niet bereikbaar: {exc}")

        if time.monotonic() - last_heartbeat >= HEARTBEAT_SECONDS:
            send_heartbeat(len(waiting))
            last_heartbeat = time.monotonic()

        for rec in waiting:
            process_phone_recording(rec)
            # Tijdens lang transcriberen blijven melden dat de pc aanstaat.
            if time.monotonic() - last_heartbeat >= HEARTBEAT_SECONDS:
                send_heartbeat(len(waiting))
                last_heartbeat = time.monotonic()
        time.sleep(PHONE_POLL_SECONDS)


threading.Thread(target=phone_queue_loop, name="telefoonopnames", daemon=True).start()
print("Wachtrij voor telefoonopnames gestart.")


if __name__ == "__main__":
    # use_reloader=False: anders laadt Flask's autoreload het large-v3-model
    # dubbel (eenmaal in het hoofdproces, eenmaal in de reloader-subprocess).
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
