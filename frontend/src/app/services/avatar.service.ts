import { Injectable } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Style, Avatar } from '@dicebear/core';
import glass from '@dicebear/styles/glass.json' with { type: 'json' };

const style = new Style(glass);

@Injectable({ providedIn: 'root' })
export class AvatarService {
  // O avatar é gerado 100% no navegador a partir do nome (usado como "seed"),
  // sem nenhuma chamada de rede — a mesma pessoa sempre recebe o mesmo desenho.
  // Guardamos em cache pra não regerar o SVG toda vez que a mensagem re-renderiza.
  private readonly cache = new Map<string, SafeUrl>();

  constructor(private sanitizer: DomSanitizer) {}

  getAvatar(userName: string): SafeUrl {
    const cached = this.cache.get(userName);
    if (cached) {
      return cached;
    }

    const dataUri = new Avatar(style, { seed: userName, size: 64 }).toDataUri();
    // O data URI foi gerado por nós mesmos (não é entrada de usuário renderizada
    // como HTML), então é seguro marcar como confiável pro Angular aceitar em [src].
    const safeUri = this.sanitizer.bypassSecurityTrustUrl(dataUri);
    this.cache.set(userName, safeUri);
    return safeUri;
  }
}
