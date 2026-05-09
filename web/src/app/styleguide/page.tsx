"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Tag } from "@/components/ui/Tag";
import { FormField } from "@/components/ui/FormField";
import { SearchBar, type SearchSuggestion } from "@/components/ui/SearchBar";
import { MoneyInput, MoneyDisplay } from "@/components/ui/MoneyInput";
import { RatingStars } from "@/components/ui/RatingStars";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal, ModalClose } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuLabel,
} from "@/components/ui/Menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import { AttachmentChip } from "@/components/ui/AttachmentChip";
import { FileUploader, type UploadedFile } from "@/components/ui/FileUploader";
import { AttachmentGallery, type GalleryItem } from "@/components/ui/AttachmentGallery";
import { CategoryPicker, type Category, type CategoryPath } from "@/components/ui/CategoryPicker";
import { DateTimePicker } from "@/components/ui/DateTimePicker";
import { PriceRange } from "@/components/ui/PriceRange";
import {
  Search,
  ArrowRight,
  Plus,
  Heart,
  Inbox,
  FileText,
  MapPin,
  MoreHorizontal,
  Edit,
  Trash2,
  Copy,
  Pause,
  CheckCircle2,
  Settings,
  AlertTriangle,
  Info,
} from "lucide-react";

const CATEGORIES: Category[] = [
  {
    id: "el",
    name: "Електрика",
    children: [
      {
        id: "el-house",
        name: "Домашня електрика",
        children: [
          { id: "el-wiring", name: "Заміна проводки" },
          { id: "el-socket", name: "Заміна розеток" },
          { id: "el-light", name: "Встановлення світильників" },
        ],
      },
      {
        id: "el-pro",
        name: "Промислова електрика",
        children: [
          { id: "el-panel", name: "Електрощити" },
          { id: "el-cable", name: "Прокладання кабелю" },
        ],
      },
    ],
  },
  {
    id: "rep",
    name: "Ремонт побутової техніки",
    children: [
      {
        id: "rep-wash",
        name: "Пральні машини",
        children: [
          { id: "rep-wash-bosch", name: "Bosch / Siemens" },
          { id: "rep-wash-lg", name: "LG / Samsung" },
          { id: "rep-wash-other", name: "Інші бренди" },
        ],
      },
      {
        id: "rep-fridge",
        name: "Холодильники",
        children: [{ id: "rep-fridge-all", name: "Всі бренди" }],
      },
    ],
  },
  {
    id: "clean",
    name: "Прибирання",
    children: [
      {
        id: "clean-flat",
        name: "Квартири",
        children: [
          { id: "clean-flat-reg", name: "Регулярне" },
          { id: "clean-flat-deep", name: "Генеральне" },
          { id: "clean-flat-after", name: "Після ремонту" },
        ],
      },
    ],
  },
];

const GALLERY_INITIAL: GalleryItem[] = [
  { id: "g1", src: "https://picsum.photos/seed/r-cover/400", alt: "cover", isCover: true },
  { id: "g2", src: "https://picsum.photos/seed/r-2/400" },
  { id: "g3", src: "https://picsum.photos/seed/r-3/400" },
  { id: "g4", src: "https://picsum.photos/seed/r-4/400" },
];

const SUGGESTIONS: SearchSuggestion[] = [
  { id: "1", label: "Ремонт пральних машин", meta: "Електропобут · 247 пропозицій", hint: "TOP" },
  { id: "2", label: "Прибирання квартир", meta: "Клінінг · 1 240 пропозицій" },
  { id: "3", label: "Електрика — заміна проводки", meta: "Електрика · 184 пропозиції" },
  { id: "4", label: "Сантехніка — заміна змішувача", meta: "Сантехніка · 412 пропозицій" },
];

function Section({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section id={id} className="border-t border-hairline py-14 first:border-t-0">
      <header className="mb-8 flex items-baseline gap-4">
        <span className="font-mono text-caption text-muted-soft">{id}</span>
        <h2 className="font-display text-h2 text-ink tracking-tight">{label}</h2>
      </header>
      <div className="space-y-10">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr] md:items-center">
      <div className="font-mono text-caption text-muted">{label}</div>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const swatches: { token: string; hex: string }[] = [
  { token: "canvas", hex: "#f7f4ee" },
  { token: "paper", hex: "#ffffff" },
  { token: "elevated", hex: "#fffdf8" },
  { token: "ink", hex: "#14110e" },
  { token: "ink-soft", hex: "#2c2924" },
  { token: "muted", hex: "#6e6862" },
  { token: "muted-soft", hex: "#948e85" },
  { token: "hairline", hex: "#e8e2d6" },
  { token: "accent", hex: "#b3361b" },
  { token: "accent-soft", hex: "#f3dcd2" },
  { token: "success", hex: "#2f6f4f" },
  { token: "warning", hex: "#a86a14" },
  { token: "danger", hex: "#a52a2a" },
  { token: "info", hex: "#2b4a7a" },
];

function ToastDemo() {
  const { push } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        leftIcon={<CheckCircle2 size={14} />}
        onClick={() =>
          push({
            tone: "success",
            title: "Лістинг опубліковано",
            description: "З'явиться у стрічці після проходження модерації.",
          })
        }
      >
        success
      </Button>
      <Button
        variant="secondary"
        leftIcon={<AlertTriangle size={14} />}
        onClick={() =>
          push({
            tone: "warning",
            title: "Ескроу спливає за 24 год",
            description: "Підтвердіть угоду, інакше кошти повернуться клієнту.",
            action: { label: "Відкрити угоду", onClick: () => {} },
          })
        }
      >
        warning + action
      </Button>
      <Button
        variant="secondary"
        leftIcon={<Info size={14} />}
        onClick={() => push({ tone: "info", title: "Збережено в чернетки" })}
      >
        info
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          push({
            tone: "danger",
            title: "Не вдалося відправити",
            description: "Перевірте з'єднання та спробуйте ще раз.",
          })
        }
      >
        danger
      </Button>
    </div>
  );
}

export default function StyleguidePage() {
  const [rating, setRating] = useState(4);
  const [price, setPrice] = useState<number | null>(120000);
  const [statement, setStatement] = useState("");
  const [category, setCategory] = useState<CategoryPath | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>(GALLERY_INITIAL);
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  const [priceRange, setPriceRange] = useState<[number, number]>([20000, 250000]);
  return (
    <main className="mx-auto max-w-5xl px-6 py-16 md:py-24">
      <header className="mb-16 flex flex-col gap-6 md:gap-8">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-caption tracking-loose uppercase text-muted">
            Robotun · Styleguide v0.1
          </span>
          <span className="font-mono text-caption text-muted-soft">2026.05.09</span>
        </div>
        <h1 className="font-display text-h1 md:text-display tracking-tight text-ink leading-[1.05]">
          Foundation,<br />
          п’ять атомів,<br />
          один погляд.
        </h1>
        <p className="max-w-2xl text-body-lg text-muted leading-relaxed">
          Це живий контракт між дизайном і кодом. Все, що внизу — фундамент,
          з якого складатимуться всі екрани Robotun. Жодних компонентів поза
          цим списком без узгодження.
        </p>
      </header>

      <Section id="00" label="Typography">
        <div className="space-y-6">
          <p className="font-display text-display tracking-tight text-ink">Майстер під ваше завдання.</p>
          <p className="font-display text-h1 text-ink">Знайдіть сьогодні.</p>
          <p className="font-display text-h2 text-ink">Електрика, ремонт, прибирання.</p>
          <h3 className="font-display text-h3 text-ink">Заголовок третього рівня</h3>
          <p className="text-body-lg text-ink">Body large — для intro-параграфів і важливих описів послуг.</p>
          <p className="text-body text-ink">Body — стандартний розмір для контенту, форм, карток.</p>
          <p className="text-caption text-muted">Caption — для метаданих, підказок, дрібних підписів.</p>
          <p className="text-micro text-muted-soft">Micro — для службових позначок, ID, timestamps.</p>
          <p className="font-mono text-caption text-muted-soft">font-mono · LST-9241 · 320,00 ₴ · 2026-05-09T10:14Z</p>
        </div>
      </Section>

      <Section id="01" label="Color">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {swatches.map((s) => (
            <div key={s.token} className="border border-hairline rounded-[var(--radius-sm)] overflow-hidden bg-paper">
              <div className="h-20" style={{ background: `var(--color-${s.token})` }} />
              <div className="p-3">
                <div className="font-sans text-body text-ink">{s.token}</div>
                <div className="font-mono text-caption text-muted-soft">{s.hex}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="02" label="Button">
        <Row label="primary">
          <Button size="sm">Малий</Button>
          <Button size="md">Стандартний</Button>
          <Button size="lg" rightIcon={<ArrowRight size={18} />}>Великий з іконкою</Button>
        </Row>
        <Row label="secondary">
          <Button variant="secondary" size="sm">Скасувати</Button>
          <Button variant="secondary" leftIcon={<Plus size={16} />}>Додати фото</Button>
        </Row>
        <Row label="accent">
          <Button variant="accent">Опублікувати</Button>
          <Button variant="accent" size="lg">Створити угоду</Button>
        </Row>
        <Row label="ghost · link">
          <Button variant="ghost" leftIcon={<Heart size={16} />}>У збережене</Button>
          <Button variant="link">Дізнатись більше →</Button>
        </Row>
        <Row label="danger">
          <Button variant="danger">Видалити лістинг</Button>
        </Row>
        <Row label="states">
          <Button loading>Завантаження</Button>
          <Button disabled>Недоступно</Button>
          <Button size="icon" variant="secondary" aria-label="Пошук">
            <Search size={16} />
          </Button>
        </Row>
      </Section>

      <Section id="03" label="Input">
        <Row label="default">
          <div className="w-full max-w-sm">
            <Input placeholder="Назва послуги" />
          </div>
        </Row>
        <Row label="with addon">
          <div className="w-full max-w-sm">
            <Input
              leftAddon={<Search size={16} />}
              placeholder="Шукати майстра, послугу, категорію"
            />
          </div>
        </Row>
        <Row label="money">
          <div className="w-full max-w-xs">
            <Input
              type="number"
              placeholder="0"
              rightAddon={<span className="font-mono text-muted">₴</span>}
            />
          </div>
        </Row>
        <Row label="error">
          <div className="w-full max-w-sm space-y-1">
            <Input tone="error" defaultValue="bademail" />
            <p className="text-caption text-danger">Введіть коректну електронну адресу.</p>
          </div>
        </Row>
        <Row label="disabled / read-only">
          <div className="w-full max-w-sm flex flex-col gap-2">
            <Input disabled placeholder="Недоступно" />
            <Input readOnly defaultValue="LST-9241 · ID" className="font-mono" />
          </div>
        </Row>
        <Row label="sizes">
          <div className="w-full max-w-md flex flex-col gap-2">
            <Input size="sm" placeholder="sm" />
            <Input size="md" placeholder="md" />
            <Input size="lg" placeholder="lg" />
          </div>
        </Row>
      </Section>

      <Section id="04" label="Avatar">
        <Row label="sizes">
          <Avatar size="xs" alt="Микола Петренко" />
          <Avatar size="sm" alt="Микола Петренко" />
          <Avatar size="md" alt="Микола Петренко" />
          <Avatar size="lg" alt="Микола Петренко" />
          <Avatar size="xl" alt="Микола Петренко" />
        </Row>
        <Row label="circle + image">
          <Avatar shape="circle" size="md" alt="Anna Hill" src="https://i.pravatar.cc/80?img=47" />
          <Avatar shape="circle" size="lg" alt="Marko Lyko" src="https://i.pravatar.cc/120?img=12" />
        </Row>
        <Row label="kyc + online">
          <Avatar size="lg" alt="Bosch Group" kycVerified />
          <Avatar size="md" shape="circle" alt="Olha K" online src="https://i.pravatar.cc/80?img=5" />
          <Avatar size="lg" alt="Verified Pro" kycVerified online />
        </Row>
      </Section>

      <Section id="05" label="Badge">
        <Row label="tones">
          <Badge>neutral</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
          <Badge tone="ink">ink</Badge>
        </Row>
        <Row label="with dot">
          <Badge tone="success" withDot>active</Badge>
          <Badge tone="warning" withDot>in review</Badge>
          <Badge tone="danger" withDot>disputed</Badge>
          <Badge tone="neutral" withDot>pending</Badge>
        </Row>
        <Row label="square + sm">
          <Badge shape="square" size="sm">v1.3</Badge>
          <Badge shape="square" size="sm" tone="ink">KYC ✓</Badge>
          <Badge shape="square" size="sm" tone="info">UAH</Badge>
        </Row>
      </Section>

      <Section id="06" label="Tag">
        <Row label="categories">
          <Tag>Електрика</Tag>
          <Tag>Прибирання</Tag>
          <Tag>Ремонт</Tag>
          <Tag>Будівництво</Tag>
        </Row>
        <Row label="soft + accent">
          <Tag variant="soft">Київ</Tag>
          <Tag variant="soft">Львів</Tag>
          <Tag variant="accent">Топ-провайдер</Tag>
        </Row>
        <Row label="selected · interactive">
          <Tag interactive>Будь-яка ціна</Tag>
          <Tag interactive selected>До 500 ₴</Tag>
          <Tag interactive>500–2000 ₴</Tag>
          <Tag interactive>2000+ ₴</Tag>
        </Row>
        <Row label="removable filter chips">
          <Tag variant="soft" onRemove={() => {}}>Київ</Tag>
          <Tag variant="soft" onRemove={() => {}}>KYC ✓</Tag>
          <Tag variant="soft" onRemove={() => {}}>До 1000 ₴</Tag>
        </Row>
      </Section>

      <Section id="07" label="FormField">
        <Row label="basic">
          <div className="w-full max-w-md">
            <FormField label="Електронна адреса" helper="Ми надішлемо лист з підтвердженням" required>
              <Input type="email" placeholder="ім’я@приклад.ua" />
            </FormField>
          </div>
        </Row>
        <Row label="error">
          <div className="w-full max-w-md">
            <FormField label="Пароль" error="Пароль має містити щонайменше 8 символів" required>
              <Input type="password" defaultValue="123" />
            </FormField>
          </div>
        </Row>
        <Row label="char count">
          <div className="w-full max-w-md">
            <FormField
              label="Опис послуги"
              helper="Опишіть, що саме ви робите — без контактів"
              optional
              charCount={{ current: statement.length, max: 500 }}
            >
              <Input
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                placeholder="Наприклад: ремонт пральних машин Bosch, Siemens, AEG"
              />
            </FormField>
          </div>
        </Row>
        <Row label="hint">
          <div className="w-full max-w-md">
            <FormField label="Місто" hint="UA · обов’язкове">
              <Input leftAddon={<MapPin size={14} />} placeholder="Київ" />
            </FormField>
          </div>
        </Row>
      </Section>

      <Section id="08" label="SearchBar">
        <Row label="md">
          <SearchBar suggestions={SUGGESTIONS} onSubmit={() => {}} />
        </Row>
        <Row label="lg">
          <SearchBar size="lg" suggestions={SUGGESTIONS} loading />
        </Row>
        <Row label="empty / no suggest">
          <SearchBar placeholder="Знайти угоду за номером або назвою" />
        </Row>
      </Section>

      <Section id="09" label="MoneyInput / Display">
        <Row label="input md">
          <div className="w-full max-w-xs">
            <MoneyInput
              valueKopecks={price}
              onChangeKopecks={setPrice}
              placeholder="0,00"
            />
          </div>
        </Row>
        <Row label="sizes">
          <div className="w-full max-w-md flex flex-col gap-2">
            <MoneyInput size="sm" defaultValueKopecks={50000} />
            <MoneyInput size="md" defaultValueKopecks={120000} />
            <MoneyInput size="lg" defaultValueKopecks={1850000} />
          </div>
        </Row>
        <Row label="states">
          <div className="w-full max-w-md grid grid-cols-2 gap-2">
            <MoneyInput tone="error" defaultValueKopecks={5} />
            <MoneyInput tone="success" defaultValueKopecks={250000} />
          </div>
        </Row>
        <Row label="display">
          <span className="text-body text-muted">Вартість угоди:</span>
          <MoneyDisplay kopecks={price} emphasize className="text-h3" />
        </Row>
        <Row label="display variants">
          <MoneyDisplay kopecks={0} className="text-body" />
          <MoneyDisplay kopecks={1234567} className="text-body" />
          <MoneyDisplay kopecks={-50000} className="text-body text-danger" />
          <MoneyDisplay kopecks={null} className="text-body text-muted-soft" />
        </Row>
      </Section>

      <Section id="10" label="RatingStars">
        <Row label="display">
          <RatingStars value={4.7} count={147} />
        </Row>
        <Row label="sizes">
          <RatingStars size="sm" value={4.5} count={32} />
          <RatingStars size="md" value={3.8} count={120} />
          <RatingStars size="lg" value={5} count={1248} />
        </Row>
        <Row label="zero">
          <RatingStars value={0} />
          <RatingStars value={0} showZero={false} />
        </Row>
        <Row label="input">
          <RatingStars mode="input" value={rating} onChange={setRating} size="lg" />
          <span className="text-caption text-muted">обрано: {rating}</span>
        </Row>
      </Section>

      <Section id="11" label="EmptyState">
        <Row label="default">
          <div className="w-full">
            <EmptyState
              numeral="01"
              title="Поки що жодних угод"
              description="Створіть першу угоду — і вона з’явиться тут разом зі статусом, ескроу і таймлайном."
              primaryAction={
                <Button leftIcon={<Plus size={16} />}>Створити угоду</Button>
              }
              secondaryAction={<Button variant="ghost">Як це працює →</Button>}
            />
          </div>
        </Row>
        <Row label="with icon · sm">
          <div className="w-full">
            <EmptyState
              size="sm"
              icon={<Inbox size={22} />}
              title="Вхідних повідомлень немає"
              description="Коли клієнт напише вам — побачите тут."
            />
          </div>
        </Row>
        <Row label="search">
          <div className="w-full">
            <EmptyState
              icon={<FileText size={22} />}
              title="Нічого не знайшли за запитом «барбер на дому»"
              description="Спробуйте інший запит або зніміть фільтри."
              primaryAction={<Button variant="secondary">Скинути фільтри</Button>}
            />
          </div>
        </Row>
      </Section>

      <Section id="12" label="Modal">
        <Row label="standard">
          <Modal
            trigger={<Button variant="secondary">Відкрити Modal</Button>}
            title="Опублікувати лістинг?"
            description="Лістинг піде на модерацію. Зазвичай це займає до 2 годин."
            footer={
              <>
                <ModalClose asChild>
                  <Button variant="ghost">Скасувати</Button>
                </ModalClose>
                <ModalClose asChild>
                  <Button variant="accent">Опублікувати</Button>
                </ModalClose>
              </>
            }
          >
            <p>
              Перевірте назву, ціну й галерею перед публікацією. Після модерації
              лістинг буде видно у пошуку.
            </p>
          </Modal>
        </Row>
        <Row label="destructive · locked">
          <Modal
            modalLock
            trigger={<Button variant="danger" leftIcon={<Trash2 size={14} />}>Видалити лістинг</Button>}
            title="Видалити «Ремонт пральних машин Bosch»?"
            description="Цю дію не можна скасувати. Активні угоди по цьому лістингу залишаться у статусі pending до завершення."
            size="lg"
            footer={
              <>
                <ModalClose asChild>
                  <Button variant="secondary">Не видаляти</Button>
                </ModalClose>
                <ModalClose asChild>
                  <Button variant="danger">Видалити назавжди</Button>
                </ModalClose>
              </>
            }
          />
        </Row>
      </Section>

      <Section id="13" label="Toast">
        <Row label="tones">
          <ToastDemo />
        </Row>
      </Section>

      <Section id="14" label="Tabs">
        <Row label="underline">
          <div className="w-full max-w-2xl">
            <Tabs defaultValue="about">
              <TabsList>
                <TabsTrigger value="about">Про мене</TabsTrigger>
                <TabsTrigger value="listings" count={12}>Послуги</TabsTrigger>
                <TabsTrigger value="reviews" count={147}>Відгуки</TabsTrigger>
                <TabsTrigger value="portfolio">Портфоліо</TabsTrigger>
              </TabsList>
              <TabsContent value="about">
                <p className="text-body text-ink-soft">
                  Тут було б опис майстра, спеціалізації, мови, локація.
                </p>
              </TabsContent>
              <TabsContent value="listings">12 послуг.</TabsContent>
              <TabsContent value="reviews">147 відгуків.</TabsContent>
              <TabsContent value="portfolio">Галерея робіт.</TabsContent>
            </Tabs>
          </div>
        </Row>
        <Row label="pill">
          <Tabs defaultValue="all">
            <TabsList variant="pill">
              <TabsTrigger value="all" variant="pill">
                Всі
              </TabsTrigger>
              <TabsTrigger value="active" variant="pill" count={3}>
                Активні
              </TabsTrigger>
              <TabsTrigger value="review" variant="pill" count={1}>
                На перевірці
              </TabsTrigger>
              <TabsTrigger value="done" variant="pill">
                Завершені
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Row>
      </Section>

      <Section id="15" label="Menu (DropdownMenu)">
        <Row label="row actions">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="Дії">
                <MoreHorizontal size={16} />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuLabel>Дії з лістингом</MenuLabel>
              <MenuItem leftIcon={<Edit size={14} />} shortcut="⌘E">Редагувати</MenuItem>
              <MenuItem leftIcon={<Copy size={14} />}>Дублювати</MenuItem>
              <MenuItem leftIcon={<Pause size={14} />}>Призупинити</MenuItem>
              <MenuSeparator />
              <MenuItem destructive leftIcon={<Trash2 size={14} />}>
                Видалити
              </MenuItem>
            </MenuContent>
          </Menu>
        </Row>
      </Section>

      <Section id="16" label="Popover">
        <Row label="form-in-popover">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" leftIcon={<Settings size={14} />}>
                Налаштування фільтра
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <h4 className="font-display text-body-lg text-ink mb-3 tracking-tight">
                Сортування
              </h4>
              <div className="flex flex-col gap-2 text-body">
                <label className="flex items-center gap-2">
                  <input type="radio" name="sort" defaultChecked /> За релевантністю
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="sort" /> Найновіші
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="sort" /> Дешевші
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="sort" /> Найкращий рейтинг
                </label>
              </div>
            </PopoverContent>
          </Popover>
        </Row>
      </Section>

      <Section id="17" label="Tooltip">
        <Row label="basic">
          <Tooltip content="KYC підтверджено через BankID">
            <Badge tone="success" withDot>KYC ✓</Badge>
          </Tooltip>
          <Tooltip content="Скопіювати ID" shortcut="⌘C" side="bottom">
            <Button variant="ghost" size="icon">
              <Copy size={14} />
            </Button>
          </Tooltip>
          <Tooltip content="Лістинг призупинений автоматично після 60 днів неактивності" side="right">
            <Badge tone="warning">auto-paused</Badge>
          </Tooltip>
        </Row>
      </Section>

      <Section id="18" label="AttachmentChip">
        <Row label="states">
          <AttachmentChip fileName="contract.pdf" sizeBytes={184320} mimeType="application/pdf" status="uploading" progress={48} />
          <AttachmentChip fileName="boiler.jpg" sizeBytes={1820480} mimeType="image/jpeg" status="scanning" />
          <AttachmentChip fileName="warranty.pdf" sizeBytes={102400} mimeType="application/pdf" status="ready" onRemove={() => {}} />
          <AttachmentChip fileName="suspicious.exe" sizeBytes={5242880} status="threat" onRemove={() => {}} />
          <AttachmentChip fileName="huge.zip" sizeBytes={120000000} status="error" errorMessage="Перевищено 100 МБ" onRemove={() => {}} />
        </Row>
      </Section>

      <Section id="19" label="FileUploader">
        <Row label="multi · 3 max">
          <div className="w-full max-w-xl">
            <FileUploader
              maxFiles={3}
              maxSizeBytes={10 * 1024 * 1024}
              hint="JPG, PNG, WebP, PDF"
              files={uploads}
              onFilesAdd={(files) =>
                setUploads((cur) => [
                  ...cur,
                  ...files.map((f) => ({
                    id: crypto.randomUUID(),
                    file: f,
                    status: "ready" as const,
                  })),
                ])
              }
              onRemove={(id) => setUploads((cur) => cur.filter((u) => u.id !== id))}
            />
          </div>
        </Row>
      </Section>

      <Section id="20" label="AttachmentGallery">
        <Row label="listing gallery (1 cover + 9)">
          <AttachmentGallery
            items={gallery}
            maxItems={10}
            onRemove={(id) => setGallery((cur) => cur.filter((g) => g.id !== id))}
            onSetCover={(id) =>
              setGallery((cur) => cur.map((g) => ({ ...g, isCover: g.id === id })))
            }
            onReorder={setGallery}
            emptyHint="Додайте до 10 фото послуги — перше стане обкладинкою."
          />
        </Row>
      </Section>

      <Section id="21" label="CategoryPicker">
        <Row label="3-level cascade">
          <div className="w-full">
            <CategoryPicker
              categories={CATEGORIES}
              value={category}
              onChange={setCategory}
            />
            <p className="mt-3 text-caption text-muted">
              Обрано:{" "}
              {category ? (
                <span className="font-mono text-ink">
                  {category.l1.name} → {category.l2.name} → {category.l3.name}
                </span>
              ) : (
                <span className="text-muted-soft">—</span>
              )}
            </p>
          </div>
        </Row>
      </Section>

      <Section id="22" label="DateTimePicker">
        <Row label="date">
          <div className="w-full max-w-xs">
            <DateTimePicker variant="date" />
          </div>
        </Row>
        <Row label="datetime">
          <div className="w-full max-w-xs">
            <DateTimePicker variant="datetime" />
          </div>
        </Row>
        <Row label="time">
          <div className="w-full max-w-[160px]">
            <DateTimePicker variant="time" />
          </div>
        </Row>
        <Row label="error">
          <div className="w-full max-w-xs">
            <DateTimePicker variant="date" tone="error" defaultValue="2024-01-01" />
          </div>
        </Row>
      </Section>

      <Section id="23" label="PriceRange">
        <Row label="filter">
          <div className="w-full max-w-md">
            <PriceRange
              value={priceRange}
              onChange={setPriceRange}
              min={0}
              max={1000000}
              step={5000}
            />
          </div>
        </Row>
      </Section>

      <footer className="mt-20 border-t border-hairline pt-8">
        <p className="font-mono text-caption text-muted-soft">
          Далі: Breadcrumbs, Pagination, Stepper, InlineAlert, CopyButton, CountBadge, Drawer, ErrorState.
        </p>
      </footer>
    </main>
  );
}
