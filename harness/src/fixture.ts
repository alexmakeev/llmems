/**
 * Russian planted-fact fixture (plan v2, D5/D12-rev/D15/D16).
 *
 * D12-rev structure: 4 coherent thematic blocks of 5-6 turns. Each block keeps
 * ONE stable topic; blocks 2-4 open with an explicit transition («давай теперь
 * про…») so the conversation visibly moves on and earlier topics become
 * closable by the BackgroundIndexer. The per-run nonce is the CENTRAL fact of
 * block 1 ONLY (>=2 turns) — phrased as the key info of that topic to maximize
 * survival through summarization. Block ordering guarantees the indexThreshold
 * trigger (default 16) fires only after >=2 topic switches; the last block is a
 * throwaway "mover" topic.
 */

export function buildFixtureBlocks(nonce: string): string[][] {
  return [
    // Block 1 — THE nonce topic: codename of the test stand (6 turns, nonce in 2)
    [
      'Привет! Сегодня надо окончательно оформить паспорт нашего тестового стенда памяти.',
      `Самое главное: кодовое имя стенда — «сирень-${nonce}». Это центральный идентификатор всего эксперимента.`,
      'Под этим кодовым именем стенд будет фигурировать во всех журналах, отчётах и бенчмарках.',
      `Зафиксируй ещё раз для надёжности: кодовое имя — «сирень-${nonce}», без него ни один прогон не засчитывается.`,
      'Паспорт стенда я положу в общий журнал экспериментов, доступ у всей команды.',
      'Отлично, с паспортом стенда закончили — тема закрыта полностью.',
    ],
    // Block 2 — vacation in Altai (5 turns)
    [
      'Давай теперь про отпуск: в августе мы едем на Алтай, пора собирать маршрут.',
      'Начнём с Чемала: там база на берегу Катуни, бронь нужна минимум за месяц.',
      'Дальше Телецкое озеро, два дня на катере с палаткой на южном берегу.',
      'Перевал Кату-Ярык оставим на конец — туда только на подготовленной машине.',
      'Итого по отпуску двенадцать дней, бюджет прикинем после брони жилья.',
    ],
    // Block 3 — mum's birthday (5 turns)
    [
      'Теперь давай к дню рождения мамы, он уже через две недели.',
      'Торт закажем в той же кондитерской, что и в прошлом году — медовик на десять персон.',
      'Подарок: она давно намекает на хороший набор для акварели и большие листы.',
      'Гостей будет восемь человек, стол накроем дома, горячее закажем.',
      'Открытку подпишем от всей семьи, заберу её в четверг после работы.',
    ],
    // Block 4 — throwaway "mover": kitchen renovation (6 turns)
    [
      'Сменим тему: давно откладывали разговор про ремонт кухни.',
      'Столешницу хотим из дуба, фартук — белая плитка «кабанчик».',
      'Старый гарнитур отдадим соседям на дачу, они давно просили.',
      'Мастер приедет мерить в субботу утром, к девяти.',
      'Технику оставляем свою, только вытяжку придётся менять под новый шкаф.',
      'Смету мастер обещал прислать в течение трёх дней после замера.',
    ],
  ];
}

export function buildFixture(nonce: string): string[] {
  return buildFixtureBlocks(nonce).flat();
}

/**
 * Recall probe — asks about the BLOCK-1 TOPIC (the stand codename) without the
 * nonce: ANN recall must land on the block-1 mem and the answer must come from
 * memory (D12-rev §6).
 */
export const RECALL_PROBE =
  'Напомни, какое кодовое имя мы выбрали для нашего тестового стенда памяти? Назови его точно.';

export function countNonceMatches(context: string, nonce: string): number {
  if (nonce.length === 0) return 0;
  let count = 0;
  let idx = context.indexOf(nonce);
  while (idx !== -1) {
    count += 1;
    idx = context.indexOf(nonce, idx + nonce.length);
  }
  return count;
}

export function assertPlantedFacts(context: string, nonce: string): boolean {
  return countNonceMatches(context, nonce) >= 1;
}
