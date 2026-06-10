Diagnosis: production config sets `requestTimeoutMs` to 12000 while the upstream deadline is 9000.
The production log shows the upstream closes around 9012ms before the app timeout fires.
The code default is 8000, so the regression is the production override, not the code default.
Recommended fix: set the production payment timeout below 9000ms, for example 8000ms.