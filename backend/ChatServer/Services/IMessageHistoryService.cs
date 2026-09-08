namespace ChatServer.Services;

/// <summary>
/// Uma mensagem guardada da Sala Geral. É um espelho do payload que o hub
/// manda em "ReceiveMessage", pra quem entra depois receber exatamente o
/// mesmo formato que receberia se estivesse online na hora.
/// </summary>
public record StoredMessage(string UserName, string Message, string Replica, string Timestamp);

/// <summary>
/// Guarda as últimas mensagens da Sala Geral, só o suficiente pra quem chega
/// (ou recarrega a página) não cair numa tela vazia.
///
/// Continua sendo um chat efêmero: a lista tem tamanho fixo e prazo de
/// validade, e some junto com o Redis. Conversa privada NÃO passa por aqui de
/// propósito, porque guardar conteúdo endereçado a uma pessoa específica é
/// outra decisão, com outras implicações de privacidade, e o projeto trata
/// mensagem privada como anônima até no visualizador.
/// </summary>
public interface IMessageHistoryService
{
    Task AddAsync(string roomName, StoredMessage message);
    Task<IReadOnlyList<StoredMessage>> GetRecentAsync(string roomName);
}
