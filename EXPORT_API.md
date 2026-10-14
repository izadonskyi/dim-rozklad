# Черга джемів з адмінки «DIM Розклад» — для бекенду

Адмінка не пише в базу DIM напряму. Передаються всі типи: Easy, Improv, Pro Cover, Voice, Special і One Band Program. Коли менеджер публікує, змінює, знімає з публікації чи скасовує джем, адмінка кладе запис у чергу у форматі вашого GraphQL (`CreateJamInput` та ін.). Бекенд забирає записи, сам створює чи оновлює джем і підтверджує обробку.

Базова адреса: `https://dim-rozklad.vercel.app/api/export`
Авторизація: заголовок `x-api-key: <EXPORT_KEY>`. Ключ видає власник адмінки.

## Отримати записи

```
GET /api/export?pending=1      # нові або змінені з моменту останнього підтвердження
GET /api/export                # усі записи
GET /api/export?since=2026-11-01T00:00:00Z
```

Відповідь:

```json
{
  "ok": true,
  "count": 1,
  "items": [
    {
      "externalId": "KYIV:0|2026-11-03|oa",
      "action": "upsert",
      "version": 1,
      "updatedAt": "2026-10-11T09:00:00.000Z",
      "jamId": null,
      "createJamInput": {
        "name": "Brit-pop / СЕСІЯ 1",
        "shortName": "Brit-pop",
        "price": 800,
        "scheduledAt": "2026-11-03T15:00:00.000Z",
        "finishTime": "2026-11-03T17:00:00.000Z",
        "categoryId": "e2b504ad-078a-46c9-9ae0-5fa3e8e14733",
        "locationId": "9ce448e4-61c7-4197-9db0-69b72b806d4a",
        "showInCatalog": true,
        "details": { "topic": "Brit-pop", "description": "..." }
      },
      "teacherIds": ["faac4404-ac75-4fb3-9d5a-1ca3a6230b00"],
      "genreIds": ["..."],
      "ticketOptions": [ { "instrument": "guitar", "total": 2 }, { "instrument": "vocal", "total": 3 } ],
      "source": {
        "type": "E", "typeName": "Easy", "city": "Київ", "location": null,
        "localDate": "2026-11-03", "localStart": "17:00", "localEnd": "19:00",
        "teachers": [ { "id": "faac…", "name": "Осолодько Ігор", "email": "…" } ],
        "genres": [ { "id": "…", "name": "рок" } ]
      },
      "warnings": [],
      "ack": null
    }
  ]
}
```

Поля:

- **externalId.** Стабільний ідентифікатор події в адмінці. Збережіть його поруч із `jam.id`: за ним наступні зміни потрапляють у той самий джем.
- **action.** Що зробити з джемом:
  - `upsert` — створити або оновити;
  - `unpublish` — перевести у `DRAFT`;
  - `cancel` — викликати `cancelJam`.
- **version.** Зростає з кожною зміною. Обробляйте лише останню версію.
- **createJamInput.** Готовий вхід для `createJam` / `updateJam`:
  - час уже в UTC (переведено з Europe/Kyiv);
  - статус адмінка не задає, його ставите ви.
- **teacherIds, genreIds, ticketOptions.** Дані для `assignTeacher`, `addGenreToJam` і `createJamTicketOption`. Інструменти в `ticketOptions`: `guitar`, `bass-guitar`, `drums`, `piano`, `vocal`, `free`.
- **skills.** Дані для `createJamSkill`: `[{ "instrument": "guitar", "description": "…" }]`.
- **backend.** Повний пакет у тому вигляді, як його показує блок «Дані для бекенду» в адмінці: `createJam` (час Kyiv-local), `assignTeacher`, `addGenreToJam`, `createJamTicketOption`, `createJamSkill`. Поля `id`, `status`, `createdAt`/`updatedAt` адмінка не передає — їх створює база.
- **source.** Сирі дані з адмінки: імена, email, назви. Знадобляться, якщо якийсь ID не визначився (тоді він `null`, а пояснення — у `warnings`).
- **jamId.** Ваш ID джему, якщо ви вже надсилали його в підтвердженні.

## Блок `event` — технічна та контентна інформація події

У кожному записі є об'єкт `event` з усією технічною та контентною інформацією. Назви полів і формат значень збігаються з Airtable, тож можна переносити поле в поле:

| Поле | Приклад | Примітка |
|---|---|---|
| WFP назва | `PRO COVER JAM @ DIM KYIV / Jamiroquai: Funk Night / СЕСІЯ 3` | Як формула в Airtable |
| Тема | `Jamiroquai: Funk Night` | |
| Bands, Commitment Sessions | `["Band 10"]`, `["Session 10"]` | Лише для One Band Program |
| Лінка На One Jam Page | `https://app.mydim.com/uk/jam/<Backend Id>/` | `Not added yet`, доки немає jamId |
| Час, Час кінця | `2026-10-31T17:30:00.000Z` | UTC, як у Airtable |
| Spotify, YouTube, Apple Music, Deezer music | URL | |
| Матеріали, Photo link | URL Google Drive | |
| Готовність матеріалів | `true` | |
| Описи для сайту | текст | |
| Жанр | `["ПОП","ФАНК"]` | Великими літерами |
| Скіли | `["Практикуємо…", "…"]` | Тексти навичок |
| Викладачі | `vocal@example.com, guitar@example.com` | Спершу вокал, потім інструменти |
| Вокал, Інструменти | email викладача | |
| Сесія | `СЕСІЯ 3` | `null` для One Band Program |
| Тип джему | `Easy`, `Improv`, `Pro Cover`, `Voice`, `Special`, `One Band Program` | |
| День тижня | `Saturday` | За київським часом |
| Тривалість годин | `2` | |
| Ціна, Кількість учасників | `"950"`, `"6"` | Рядком, як singleSelect |
| Локація | `DIM Space (Євгена Коновальця, 44А)` | |
| Місто | `KYIV` / `LVIV` | |
| Структура квитків | `{"name":"Pro Cover 1 guitar","Гітара":1,"Бас":1,…}` | Назва зі списку Airtable і розклад по інструментах |
| Backend Id | ваш jamId | Після підтвердження |
| Місяць (індекс і назва) | `2026-10 (October)` | |
| Статус в системі | `["ГОТОВО ДО ПУБЛІКАЦІЇ"]` | Також `ОНОВИТИ`, `НЕ В КАТАЛОЗІ`, `СКАСОВАНО` |
| Показувати в каталозі, Доступ, Зовнішній продаж квитків | `true`, `open`, URL | Додатково |

Значення статусу:

- `ГОТОВО ДО ПУБЛІКАЦІЇ` — новий джем;
- `ОНОВИТИ` — джем уже опубліковано (є підтвердження з jamId), а в адмінці його змінили;
- `НЕ В КАТАЛОЗІ` — знято з публікації;
- `СКАСОВАНО` — скасовано.

## Підтвердити обробку

```
POST /api/export
x-api-key: <EXPORT_KEY>
Content-Type: application/json

{ "externalId": "KYIV:0|2026-11-03|oa", "version": 1, "status": "done", "jamId": "uuid-джему" }
```

Помилку підтверджуйте так: `"status": "error", "message": "текст"`. Менеджер побачить її в адмінці.

Можна надіслати масив підтверджень одним запитом. Після підтвердження запис зникає з `?pending=1`, доки в адмінці не з'явиться нова версія.

## Рекомендований цикл (cron раз на кілька хвилин)

1. `GET ?pending=1`
2. Для кожного запису:
   - `upsert` без збереженого `jam.id`: `createJam` → `assignTeacher` / `addGenreToJam` / `createJamTicketOption` → за потреби публікація.
   - `upsert` з наявним `jam.id`: `updateJam`, потім звірити викладачів, жанри й квитки.
   - `unpublish` / `cancel`: оновити статус.
3. `POST` підтвердження з `jamId`.
