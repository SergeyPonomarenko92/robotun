/**
 * Module 2 mock — 3-level category tree, public endpoint per spec §4.6.
 * Real backend serves from materialized `categories` rows with parent FK
 * cycle prevention + slug uniqueness; mock holds a static tree that mirrors
 * the listings seed taxonomy so /listings can attach to leaves.
 */

export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  children?: CategoryNode[];
};

export const CATEGORY_TREE: CategoryNode[] = [
  {
    id: "el",
    slug: "elektryka",
    name: "Електрика",
    children: [
      {
        id: "el-house",
        slug: "domashnia",
        name: "Домашня електрика",
        children: [
          { id: "el-wiring", slug: "provodka", name: "Заміна проводки" },
          { id: "el-socket", slug: "rozetky", name: "Заміна розеток" },
          { id: "el-light", slug: "svitylnyky", name: "Встановлення світильників" },
        ],
      },
    ],
  },
  {
    id: "rep",
    slug: "remont-tekhniky",
    name: "Ремонт побутової техніки",
    children: [
      {
        id: "rep-wash",
        slug: "pralni-mashyny",
        name: "Пральні машини",
        children: [
          { id: "rep-wash-bosch", slug: "bosch-siemens", name: "Bosch / Siemens" },
          { id: "rep-wash-lg", slug: "lg-samsung", name: "LG / Samsung" },
          { id: "rep-wash-other", slug: "inshi", name: "Інші бренди" },
        ],
      },
      {
        id: "rep-fridge",
        slug: "kholodylnyky",
        name: "Холодильники",
        children: [
          { id: "rep-fridge-all", slug: "usi-brendy", name: "Всі бренди" },
        ],
      },
    ],
  },
  {
    id: "plumb",
    slug: "santekhnika",
    name: "Сантехніка",
    children: [
      {
        id: "plumb-pipes",
        slug: "truby-ta-stoky",
        name: "Труби та стоки",
        children: [
          { id: "plumb-leak", slug: "tech-truby", name: "Усунення протікання" },
          { id: "plumb-clog", slug: "zasmichennia", name: "Усунення засмічень" },
        ],
      },
    ],
  },
  {
    id: "clean",
    slug: "prybyrannia",
    name: "Прибирання",
    children: [
      {
        id: "clean-flat",
        slug: "kvartyry",
        name: "Квартири",
        children: [
          { id: "clean-flat-reg", slug: "rehuliarne", name: "Регулярне" },
          { id: "clean-flat-deep", slug: "heneralne", name: "Генеральне" },
        ],
      },
    ],
  },
  {
    id: "furn",
    slug: "mebli",
    name: "Меблі під замовлення",
    children: [
      {
        id: "furn-kitchen",
        slug: "kukhni",
        name: "Кухні",
        children: [
          { id: "furn-kitchen-mod", slug: "modulni", name: "Модульні" },
        ],
      },
    ],
  },
  {
    id: "fix",
    slug: "drribnyi-remont",
    name: "Дрібний ремонт",
    children: [
      {
        id: "fix-home",
        slug: "vdoma",
        name: "Вдома",
        children: [
          { id: "fix-mount", slug: "montazh", name: "Монтаж картин/полиць" },
        ],
      },
    ],
  },
  {
    id: "climate",
    slug: "klimat",
    name: "Клімат-системи",
    children: [
      {
        id: "climate-ac",
        slug: "kondytsioner",
        name: "Кондиціонери",
        children: [
          { id: "climate-ac-mount", slug: "montazh-ac", name: "Монтаж" },
          { id: "climate-ac-clean", slug: "chystka-ac", name: "Чистка та сервіс" },
        ],
      },
    ],
  },
];
