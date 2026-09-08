namespace ChatServer.Services;

/// <summary>
/// Diz de quem é cada nome de usuário, para separar "outra pessoa querendo o
/// mesmo nome" de "a mesma aba reconectando".
///
/// Só o registro de réplicas vivas não resolve isso. Quando uma réplica morre
/// de repente, ela ainda é considerada viva durante alguns segundos, até o
/// aviso dela vencer; e a reconexão automática do SignalR tenta bem antes
/// disso (a primeira tentativa é imediata). Nessa janela, a checagem por
/// réplica viva encontrava o registro que a própria pessoa tinha deixado e
/// recusava a reconexão dela. Verificado ao vivo: matando o container com
/// SIGKILL, a pessoa levava "esse nome já está em uso" de si mesma.
///
/// Com um identificador estável por aba, a pergunta deixa de ser "esse nome
/// está ocupado?" e passa a ser "esse nome está ocupado POR OUTRO?", que é a
/// pergunta que realmente interessa.
/// </summary>
public interface INameOwnershipService
{
    /// <summary>
    /// Reserva o nome para este cliente. Devolve true quando o nome estava
    /// livre ou já era deste mesmo cliente (o caso da reconexão), e false
    /// quando pertence a outro.
    /// </summary>
    Task<bool> TryClaimAsync(string roomName, string userName, string clientId);

    /// <summary>
    /// Libera o nome, mas só se ainda pertencer a este cliente: sem essa
    /// checagem, a desconexão atrasada de uma aba antiga liberaria um nome que
    /// outra já tinha assumido.
    /// </summary>
    Task ReleaseAsync(string roomName, string userName, string clientId);
}
