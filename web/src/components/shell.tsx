/*
  The frame: an inset sidebar on a tinted ground, the page a white card on it.
  Navigation: the overview, one entry per product, then the cross-product data.
*/
import { Activity, Bot, CreditCard, GitFork, LayoutGrid, LogOut, Menu, Moon, PlayCircle, Sun, Users } from "lucide-react";
import { ProductIcon } from "@/components/icons";
import { useEffect, useState } from "react";
import { api, type Me } from "@/lib/api";
import { useRoute } from "@/lib/route";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";

type Item = { href: string; label: string; icon?: React.ComponentType<{ className?: string }>; product?: string; active: (path: string) => boolean };

function NavItem({ item, path }: { item: Item; path: string }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const active = item.active(path);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.label}
        className="text-foreground hover:bg-sidebar-accent/40 data-active:bg-sidebar-accent [&_svg]:text-foreground"
        render={<a href={item.href} aria-current={active ? "page" : undefined} onClick={() => isMobile && setOpenMobile(false)} />}
      >
        {Icon ? <Icon /> : <ProductIcon id={item.product!} name={item.label} className="size-5 rounded-md" />}
        <span className="flex-1 truncate">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("csa_theme", dark ? "dark" : "light");
  }, [dark]);
  const Icon = dark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-label={dark ? "Light theme" : "Dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 group-data-[collapsible=icon]:hidden"
    >
      <Icon className="size-4" />
    </button>
  );
}

/** Phones: the main screens one thumb away, the rest (products, payments, health) behind More. */
function TabBar({ path }: { path: string }) {
  const { setOpenMobile } = useSidebar();
  const tabs = [
    { href: "#/", label: "Overview", icon: LayoutGrid, on: path === "/" || path.startsWith("/p/") },
    { href: "#/people", label: "Users", icon: Users, on: path === "/people" },
    { href: "#/funnels", label: "Funnels", icon: GitFork, on: path === "/funnels" },
    { href: "#/replays", label: "Replays", icon: PlayCircle, on: path === "/replays" },
  ];
  const cls = "flex min-w-0 flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[0.6875rem] font-medium outline-none focus-visible:bg-muted";
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {tabs.map((t) => (
        <a key={t.href} href={t.href} aria-current={t.on ? "page" : undefined} className={cn(cls, t.on ? "text-foreground" : "text-muted-foreground")}>
          <t.icon className="size-5" />{t.label}
        </a>
      ))}
      <button type="button" onClick={() => setOpenMobile(true)} className={cn(cls, "text-muted-foreground")}><Menu className="size-5" />More</button>
    </nav>
  );
}

export function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const { path } = useRoute();
  const products: Item[] = me.products.map((p) => ({ href: `#/p/${p.id}`, label: p.name, product: p.id, active: (x) => x === `/p/${p.id}` }));
  const data: Item[] = [
    { href: "#/people", label: "Users", icon: Users, active: (x) => x === "/people" },
    { href: "#/funnels", label: "Funnels", icon: GitFork, active: (x) => x === "/funnels" },
    { href: "#/ai", label: "AI & bots", icon: Bot, active: (x) => x === "/ai" },
    { href: "#/replays", label: "Replays", icon: PlayCircle, active: (x) => x.startsWith("/replays") || x.startsWith("/r/") },
    { href: "#/payments", label: "Payments", icon: CreditCard, active: (x) => x === "/payments" },
    { href: "#/health", label: "Health", icon: Activity, active: (x) => x === "/health" },
  ];
  return (
    <SidebarProvider className="md:h-svh md:overflow-hidden">
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader className="px-3 pt-3.5 pb-1 group-data-[collapsible=icon]:px-2">
          <div className="flex h-8 items-center justify-between gap-2 px-1">
            <Logo className="group-data-[collapsible=icon]:hidden" />
            <SidebarTrigger className="hidden md:flex group-data-[collapsible=icon]:mx-auto" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                <NavItem path={path} item={{ href: "#/", label: "Overview", icon: LayoutGrid, active: (x) => x === "/" }} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarGroupLabel>Products</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">{products.map((i) => <NavItem key={i.href} item={i} path={path} />)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarGroupLabel>Data</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">{data.map((i) => <NavItem key={i.href} item={i} path={path} />)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-3 pb-3 group-data-[collapsible=icon]:px-2">
          <div className="flex items-center gap-1.5 rounded-lg border bg-background p-2.5 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold">{me.operator.slice(0, 1)}</span>
            <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold">{me.operator}</span>
              <span className="truncate text-xs text-muted-foreground">{me.products.length} products</span>
            </div>
            <ThemeToggle />
            <button
              type="button"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
                window.dispatchEvent(new Event("csa:signed-out"));
              }}
              aria-label="Sign out"
              title="Sign out"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 group-data-[collapsible=icon]:hidden"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 outline-none md:overflow-x-hidden md:overflow-y-auto md:overscroll-y-contain md:overscroll-x-auto md:ring-1 md:ring-foreground/5">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:hidden">
          <SidebarTrigger />
          <Logo />
        </header>
        <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-28 md:px-8 md:pt-10 md:pb-32">{children}</div>
      </SidebarInset>
      <TabBar path={path} />
    </SidebarProvider>
  );
}

/** Title and the page's controls, the page header. */
export function PageHeader({ title, meta, children, className }: { title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{children}</div>}
    </div>
  );
}
