# Optional French captions

Galène can display live captions from [galene-stt](https://github.com/jech/galene-stt).
Build it according to its instructions, use a multilingual Whisper model, and
give the dedicated account the group permissions `["caption", "caption-on-demand"]`.
The second permission limits the account to audio and only makes it available
while a group operator has started transcription from **Plus**. Participants
can toggle the caption display independently.

Run `python3 contrib/galene-stt/password-file.py /path/to/galene-stt` before
building the caption client to read a password from a private file. With
systemd, expose the file through `LoadCredential=` and pass its in-service path
to `-password-file`.

```sh
galene-stt -caption -lang fr -gpu=false -username speech-to-text \
  -password-file /run/credentials/captions/password \
  -model /path/to/multilingual-model.bin https://galene.example/group/example/
```

Keep the credential and the model outside this repository. Benchmark with
representative audio before enabling transcription on a shared server.
