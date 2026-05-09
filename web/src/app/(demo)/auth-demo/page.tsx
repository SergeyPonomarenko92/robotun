import Link from "next/link";
import { AuthShell } from "@/components/organisms/AuthShell";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function AuthDemoPage() {
  return (
    <AuthShell
      title={<>Увійдіть<br />у Robotun.</>}
      subtitle="Введіть електронну адресу, на яку зареєстровано акаунт. Надішлемо magic link."
      footer={
        <>
          Ще не з нами?{" "}
          <Link href="#" className="text-ink underline underline-offset-4">
            Створити акаунт
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5">
        <FormField label="Електронна адреса" required>
          <Input type="email" placeholder="імʼя@приклад.ua" />
        </FormField>
        <Button size="lg" type="submit">
          Надіслати magic link
        </Button>
        <div className="relative my-2">
          <div className="absolute inset-0 flex items-center" aria-hidden>
            <div className="w-full h-px bg-hairline" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-canvas px-3 font-mono text-micro uppercase tracking-loose text-muted-soft">
              або
            </span>
          </div>
        </div>
        <Button size="lg" variant="secondary" type="button">
          Увійти через Google
        </Button>
      </form>
    </AuthShell>
  );
}
