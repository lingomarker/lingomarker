# lingomarker

Learn a foreign language by reading your favorite articles and listening to your favorite podcasts.

```
curl -k -X POST \
  https://dev.lingomarker.com:8443/api/podcasts \
  -H "Cookie: lingomarker_session=e7360e7a-9b50-4b7c-809a-e6931b308cc1" \
  -F "producer=NPR" \
  -F "series=Test Series" \
  -F "episode=Test Episode 1" \
  -F "description=<./test/description.txt" \
  -F "original_transcript=<./test/original_transcript.txt" \
  -F "audio_file=@./test/NPR8115733396.mp3"
```  
