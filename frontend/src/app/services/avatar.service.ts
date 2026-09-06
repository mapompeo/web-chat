import { Injectable } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Style, Avatar } from '@dicebear/core';
import avataaars from '@dicebear/styles/avataaars.json' with { type: 'json' };

// "avataaars" desenha um rostinho de verdade (cabelo, olhos, boca, roupa) em
// vez de uma forma abstrata; a variação vem da combinação de traços, então dá
// pra reconhecer a pessoa pelo desenho, não só pela cor.
const style = new Style(avataaars);

// Fundo pastel atrás do rosto pra ele não ficar recortado/flutuando sobre o
// balão da mensagem. São tons claros de propósito: funcionam nos dois temas.
const BACKGROUND_COLORS = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf'];

@Injectable({ providedIn: 'root' })
export class AvatarService {
  // O avatar é gerado 100% no navegador a partir do nome (usado como "seed"),
  // sem nenhuma chamada de rede; a mesma pessoa sempre recebe o mesmo desenho.
  // Guardamos em cache pra não regerar o SVG toda vez que a mensagem re-renderiza.
  private readonly cache = new Map<string, SafeUrl>();

  constructor(private sanitizer: DomSanitizer) {}

  getAvatar(userName: string): SafeUrl {
    const cached = this.cache.get(userName);
    if (cached) {
      return cached;
    }

    const dataUri = new Avatar(style, {
      seed: userName,
      size: 64,
      backgroundColor: BACKGROUND_COLORS
    }).toDataUri();
    // O data URI foi gerado por nós mesmos (não é entrada de usuário renderizada
    // como HTML), então é seguro marcar como confiável pro Angular aceitar em [src].
    const safeUri = this.sanitizer.bypassSecurityTrustUrl(dataUri);
    this.cache.set(userName, safeUri);
    return safeUri;
  }
}
