import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-24 md:py-32">
      <div className="flex items-baseline justify-between mb-16">
        <span className="font-mono text-caption tracking-loose uppercase text-muted">
          Robotun
        </span>
        <Badge shape="square" size="sm">v0.1 · foundation</Badge>
      </div>
      <h1 className="font-display text-h1 md:text-display text-ink tracking-tight leading-[1.02] mb-10">
        Маркетплейс послуг,<br />
        який не виглядає,<br />
        як решта.
      </h1>
      <p className="max-w-xl text-body-lg text-muted leading-relaxed mb-12">
        Поки тут лише фундамент: токени, шрифти, перші п’ять атомів.
        Із них складатимуться всі майбутні екрани.
      </p>
      <Link href="/styleguide">
        <Button size="lg" rightIcon={<ArrowRight size={18} />}>
          Відкрити styleguide
        </Button>
      </Link>
    </main>
  );
}
